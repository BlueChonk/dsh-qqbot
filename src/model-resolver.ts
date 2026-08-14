/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理 per-peer 的模型偏好（隔离存储，不污染全局 settings.yaml）
 *
 * 优先级（从高到低）：
 *   per-peer 偏好（~/.dsh-qqbot/model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > settings.yaml 的 agent-default-model（只读，作为默认兜底）
 *   > 宿主 agentDefaultModel 服务
 *
 * 从 SessionManager 中解耦，使其专注于 session 生命周期管理。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from './config.js';

/** 模型路由 */
export interface ModelRoute {
  provider: string;
  model: string;
}

/** 模型信息条目 */
export interface ModelEntry {
  provider: string;
  id: string;
  name?: string;
}

/** settings.yaml 中的 provider 配置结构 */
interface SettingsProviderConfig {
  models?: Array<{ id?: string; name?: string }>;
  [key: string]: unknown;
}

/** settings.yaml 的 llm-pi-ai 段结构 */
interface LlmPiAiSettings {
  providers?: Record<string, SettingsProviderConfig>;
}

/** 隔离偏好文件结构 */
interface PrefsFile {
  overrides: Record<string, ModelRoute>;
  /** sessionKey → 最新 sessionId（fork 后更新，用于重启后恢复到 fork 后的会话） */
  sessionIds: Record<string, string>;
}

export class ModelResolver {
  /** per-peer 模型偏好（内存态） */
  private overrides = new Map<string, ModelRoute>();
  /** per-peer 最新 sessionId（fork 后更新，内存态） */
  private sessionIds = new Map<string, string>();
  /** settings.yaml 缓存 */
  private settingsCache: Record<string, unknown> | null | undefined;
  /** 隔离偏好文件路径 */
  private readonly prefsPath = resolve(homedir(), '.dsh-qqbot', 'model-prefs.json');

  constructor(
    private readonly ctx: Context,
    private readonly config: ImQQBotConfig,
  ) {
    this.loadPrefs();
  }

  /**
   * 获取指定 sessionKey 的有效模型路由（create 用）
   *
   * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
   */
  getEffectiveRoute(sessionKey: string): ModelRoute | undefined {
    return this.overrides.get(sessionKey) ?? this.resolveDefault();
  }

  /**
   * 获取 resume 时覆盖 session 的模型路由（对齐 dsh-TUI 语义）
   *
   * 仅「用户显式切换的 per-peer 偏好」和「cordis.yml 显式配置」才覆盖
   * session 自己的 requestHeader；否则返回 undefined，让 session 沿用
   * 自己历史里记录的模型（session 记住模型，避免重启后模型漂移）。
   */
  getResumeRoute(sessionKey: string): ModelRoute | undefined {
    // 1. per-peer 偏好（用户明确 /model 切换过）
    const override = this.overrides.get(sessionKey);
    if (override) return override;

    // 2. cordis.yml 显式配置
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    // 3. 都不指定：undefined，尊重 session 自己的 requestHeader
    return undefined;
  }

  /**
   * 设置 per-peer 模型偏好并持久化到隔离文件
   */
  setOverride(sessionKey: string, route: ModelRoute): void {
    this.overrides.set(sessionKey, route);
    this.writePrefs();
  }

  /**
   * 清除 per-peer 模型偏好并持久化
   */
  clearOverride(sessionKey: string): void {
    if (this.overrides.delete(sessionKey)) {
      this.writePrefs();
    }
  }

  /**
   * 是否存在指定 session 的模型偏好
   */
  hasOverride(sessionKey: string): boolean {
    return this.overrides.has(sessionKey);
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.sessionIds.get(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
   */
  setSessionId(sessionKey: string, sessionId: string): void {
    this.sessionIds.set(sessionKey, sessionId);
    this.writePrefs();
  }

  /**
   * 清除指定 sessionKey 的 sessionId 记录
   */
  clearSessionId(sessionKey: string): void {
    if (this.sessionIds.delete(sessionKey)) {
      this.writePrefs();
    }
  }

  /**
   * 解析默认模型路由（不含 per-peer 偏好）
   *
   * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
   */
  resolveDefault(): ModelRoute | undefined {
    // 1. config 中显式指定
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    // 2. 从 settings.yaml 直接读取（只读，作为默认兜底）
    const fromSettings = this.readDefaultFromSettings();
    if (fromSettings) return fromSettings;

    // 3. 从宿主 agentDefaultModel 服务读取
    return this.readFromHost();
  }

  /**
   * 列出所有可用模型
   */
  listModels(): ModelEntry[] {
    return this.readModelsFromSettings();
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
    // 1. 尝试宿主
    try {
      const llm = this.getService('llm') as
        | { listProviders(): Array<{ id: string; name: string }> | string[] }
        | undefined;

      if (llm && typeof llm.listProviders === 'function') {
        const providers = llm.listProviders();
        if (providers.length > 0) {
          const first = providers[0];
          if (typeof first === 'string') return providers as string[];
          return (providers as Array<{ id: string; name: string }>).map((p) => p.id);
        }
      }
    } catch {
      // 忽略
    }

    // 2. 兜底 settings.yaml
    const settings = this.loadSettings();
    const llmPiAi = settings?.['llm-pi-ai'] as LlmPiAiSettings | undefined;
    return llmPiAi?.providers ? Object.keys(llmPiAi.providers) : [];
  }

  // ── 隔离偏好文件 ──

  /** 从隔离偏好文件加载 per-peer 偏好 */
  private loadPrefs(): void {
    try {
      if (!existsSync(this.prefsPath)) return;
      const content = readFileSync(this.prefsPath, 'utf8');
      const data = JSON.parse(content) as PrefsFile;
      if (data.overrides && typeof data.overrides === 'object') {
        for (const [key, route] of Object.entries(data.overrides)) {
          if (route.provider && route.model) {
            this.overrides.set(key, { provider: route.provider, model: route.model });
          }
        }
      }
      if (data.sessionIds && typeof data.sessionIds === 'object') {
        for (const [key, sessionId] of Object.entries(data.sessionIds)) {
          if (typeof sessionId === 'string' && sessionId) {
            this.sessionIds.set(key, sessionId);
          }
        }
      }
    } catch (err) {
      if (this.config.debug) {
        console.log(`[im-qqbot] loadPrefs failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 将 per-peer 偏好写回隔离文件 */
  private writePrefs(): void {
    try {
      mkdirSync(dirname(this.prefsPath), { recursive: true });
      const data: PrefsFile = {
        overrides: Object.fromEntries(this.overrides.entries()),
        sessionIds: Object.fromEntries(this.sessionIds.entries()),
      };
      writeFileSync(this.prefsPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      if (this.config.debug) {
        console.log(`[im-qqbot] writePrefs failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // ── 私有方法 ──

  private readFromHost(): ModelRoute | undefined {
    try {
      const agentDefaultModel = this.getService('agentDefaultModel') as
        | { currentSelection(): { provider: string; model: string } }
        | undefined;

      if (agentDefaultModel && typeof agentDefaultModel.currentSelection === 'function') {
        const selection = agentDefaultModel.currentSelection();
        if (selection?.provider && selection?.model) {
          return { provider: selection.provider, model: selection.model };
        }
      }
    } catch (err) {
      if (this.config.debug) {
        console.log(`[im-qqbot] ModelResolver: host service failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  }

  private readDefaultFromSettings(): ModelRoute | undefined {
    const settings = this.loadSettings();
    if (!settings) return undefined;

    const defaultModel = settings['agent-default-model'] as
      | { provider?: string; model?: string }
      | undefined;

    if (defaultModel?.provider && defaultModel?.model) {
      return { provider: defaultModel.provider, model: defaultModel.model };
    }
    return undefined;
  }

  private readModelsFromSettings(): ModelEntry[] {
    const settings = this.loadSettings();
    if (!settings) return [];

    const models: ModelEntry[] = [];
    const llmPiAi = settings['llm-pi-ai'] as LlmPiAiSettings | undefined;

    if (llmPiAi?.providers) {
      for (const [providerName, providerConfig] of Object.entries(llmPiAi.providers)) {
        if (Array.isArray(providerConfig?.models)) {
          for (const m of providerConfig.models) {
            if (m.id) {
              models.push({ provider: providerName, id: m.id, name: m.name || undefined });
            }
          }
        }
      }
    }

    return models;
  }

  private loadSettings(): Record<string, unknown> | null {
    if (this.settingsCache !== undefined) return this.settingsCache;

    try {
      const settingsPath = resolve(homedir(), '.dsh', 'settings.yaml');
      if (!existsSync(settingsPath)) {
        this.settingsCache = null;
        return null;
      }
      const content = readFileSync(settingsPath, 'utf8');
      this.settingsCache = yaml.load(content) as Record<string, unknown> | null;
      return this.settingsCache;
    } catch {
      this.settingsCache = null;
      return null;
    }
  }

  /** 统一的 Cordis 服务访问 */
  private getService(name: string): unknown {
    const ctxAny = this.ctx as unknown as Record<string, unknown>;
    return ctxAny[name] ??
      (typeof ctxAny.get === 'function' ? (ctxAny.get as (key: string) => unknown)(name) : undefined);
  }
}
