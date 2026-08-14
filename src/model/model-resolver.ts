/**
 * ModelResolver — 统一的模型发现与路由解析
 *
 * 职责：
 *   1. 解析当前生效的默认模型路由
 *   2. 列出可用 providers 和模型
 *   3. 管理 per-peer 的模型偏好（委托 PrefsStore）
 *
 * 优先级（从高到低）：
 *   per-peer 偏好（~/.dsh-qqbot/model-prefs.json）
 *   > config 显式指定（cordis.yml 的 provider/model）
 *   > settings.yaml 的 agent-default-model（只读，作为默认兜底）
 *   > 宿主 agentDefaultModel 服务
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ImQQBotConfig } from '../config.js';
import type { ModelRoute, ModelEntry } from './types.js';
import { PrefsStore } from './prefs-store.js';
import { SettingsReader } from './settings-reader.js';

export class ModelResolver {
  private readonly prefs: PrefsStore;
  private readonly settings: SettingsReader;

  constructor(
    private readonly ctx: Context,
    private readonly config: ImQQBotConfig,
  ) {
    this.prefs = new PrefsStore(config.debug);
    this.settings = new SettingsReader();
  }

  /**
   * 获取指定 sessionKey 的有效模型路由（create 用）
   *
   * 优先级：per-peer 偏好 > config 显式指定 > settings.yaml > 宿主服务
   */
  getEffectiveRoute(sessionKey: string): ModelRoute | undefined {
    return this.prefs.getOverride(sessionKey) ?? this.resolveDefault();
  }

  /**
   * 获取 resume 时覆盖 session 的模型路由（对齐 dsh-TUI 语义）
   *
   * 仅「用户显式切换的 per-peer 偏好」和「cordis.yml 显式配置」才覆盖
   * session 自己的 requestHeader；否则返回 undefined，让 session 沿用
   * 自己历史里记录的模型（session 记住模型，避免重启后模型漂移）。
   */
  getResumeRoute(sessionKey: string): ModelRoute | undefined {
    const override = this.prefs.getOverride(sessionKey);
    if (override) return override;

    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    return undefined;
  }

  /**
   * 设置 per-peer 模型偏好并持久化到隔离文件
   */
  setOverride(sessionKey: string, route: ModelRoute): void {
    this.prefs.setOverride(sessionKey, route);
  }

  /**
   * 清除 per-peer 模型偏好并持久化
   */
  clearOverride(sessionKey: string): void {
    this.prefs.clearOverride(sessionKey);
  }

  /**
   * 是否存在指定 session 的模型偏好
   */
  hasOverride(sessionKey: string): boolean {
    return this.prefs.hasOverride(sessionKey);
  }

  /**
   * 获取指定 sessionKey 的最新 sessionId（fork 后记录，重启恢复用）
   */
  getSessionId(sessionKey: string): string | undefined {
    return this.prefs.getSessionId(sessionKey);
  }

  /**
   * 记录指定 sessionKey 的最新 sessionId（fork 后调用）并持久化
   */
  setSessionId(sessionKey: string, sessionId: string): void {
    this.prefs.setSessionId(sessionKey, sessionId);
  }

  /**
   * 清除指定 sessionKey 的 sessionId 记录
   */
  clearSessionId(sessionKey: string): void {
    this.prefs.clearSessionId(sessionKey);
  }

  /**
   * 解析默认模型路由（不含 per-peer 偏好）
   *
   * 优先级：config 显式指定 > settings.yaml（只读） > 宿主 agentDefaultModel
   */
  resolveDefault(): ModelRoute | undefined {
    if (this.config.provider && this.config.model) {
      return { provider: this.config.provider, model: this.config.model };
    }

    const fromSettings = this.settings.readDefaultRoute();
    if (fromSettings) return fromSettings;

    return this.readFromHost();
  }

  /**
   * 列出所有可用模型
   */
  listModels(): ModelEntry[] {
    return this.settings.readModels();
  }

  /**
   * 列出可用 provider 名称
   */
  listProviders(): string[] {
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

    return this.settings.readProviders();
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

  /** 统一的 Cordis 服务访问 */
  private getService(name: string): unknown {
    const ctxAny = this.ctx as unknown as Record<string, unknown>;
    return ctxAny[name] ??
      (typeof ctxAny.get === 'function' ? (ctxAny.get as (key: string) => unknown)(name) : undefined);
  }
}
