/**
 * SessionManager — 管理 QQ peer → dsh Agent 的映射和生命周期
 *
 * sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`
 *   - c2c:   peerId = senderId (用户 openid)
 *   - group: peerId = groupOpenid
 *
 * SessionId 由 sessionKey 确定性派生（SHA-256），
 * 保证同一个用户/群的消息始终路由到同一个会话，
 * 重启后可根据 key 恢复 session。
 *
 * 支持 agent-presets 系统：通过 setup hook 在 create/resume 时
 * 挂载 preset（工具集、prompt sections 等），实现场景化配置。
 */
import { createHash, randomUUID } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from './types.js';
import type { ImQQBotConfig } from './config.js';
import { ModelResolver } from './model-resolver.js';
import type { ModelRoute, ModelEntry } from './model-resolver.js';

export type { ModelRoute, ModelEntry } from './model-resolver.js';

/** AgentSetup hook 类型 */
export type AgentSetup = (agentCtx: Context) => Promise<void> | void;

/** dsh Agent 简化接口 */
export interface DshAgent {
  readonly id: string;
  readonly ctx: Context;
  /** 底层 session（fork 时作为 source） */
  readonly session: { readonly id: string };
  cancel(cause: { kind: string }): void;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

export interface DshAgentHandle {
  agent: DshAgent;
  dispose(): Promise<void>;
}

/** sessions 服务（fork 能力） */
export interface SessionsService {
  fork(source: unknown, boundary?: number): { events: readonly unknown[] };
}

export interface DshAgentRegistry {
  /** 获取进程内已存活的 agent */
  get(sessionId: string): DshAgent | undefined;
  /** 从持久化存储恢复 session */
  resume(options: {
    resumeSessionId: string;
    agentOptions?: { provider?: string; model?: string };
    setup?: AgentSetup;
  }): Promise<DshAgentHandle>;
  /** 创建全新 session */
  create(options: {
    sessionId: string;
    meta?: { cwd?: string; parentSession?: string; seedLength?: number; agentPreset?: string };
    seed?: readonly unknown[];
    agentOptions?: { provider?: string; model?: string };
    setup?: AgentSetup;
  }): Promise<DshAgentHandle>;
}

/** agent-presets 服务接口（可选，部署中可能没有） */
export interface AgentPresetsLike {
  readonly defaultId: string;
  resolve(id?: string): Promise<{ id: string }>;
  mount(agentCtx: Context, id?: string): Promise<unknown>;
}

/** preset 组合结果 */
interface PresetComposition {
  agentPreset?: string;
  setup?: AgentSetup;
}

/** 单个会话记录 */
export interface SessionRecord {
  sessionKey: string;
  sessionId: string;
  agent: DshAgent;
  handle: DshAgentHandle;
  replyTarget: ReplyTarget;
  scope: ChatScope;
  peerId: string;
  senderId: string;
  lastActivity: number;
  agentPreset?: string;
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly modelResolver: ModelResolver;

  constructor(
    private readonly ctx: Context,
    private readonly agents: DshAgentRegistry,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
  ) {
    this.modelResolver = new ModelResolver(ctx, config);

    if (config.sessionIdleTimeout > 0) {
      this.idleTimer = setInterval(() => this.evictIdle(), 60_000);
    }
  }

  /**
   * 动态获取 sessions 服务（fork 能力，可选）
   *
   * 对齐 dsh-TUI：每次调用时 ctx.get('sessions')，而非构造时缓存。
   * Cordis 服务可能延迟挂载，动态获取能拿到调用时的最新实例。
   * 用 ctx.get 而非 ctx.sessions 属性访问：sessions 未在 inject 列表。
   */
  private getSessionsService(): SessionsService | undefined {
    try {
      return this.ctx.get('sessions') as SessionsService | undefined;
    } catch {
      return undefined;
    }
  }

  // ── 模型相关（委托给 ModelResolver） ──

  /**
   * 获取指定会话的当前有效模型路由
   */
  getEffectiveModel(scope: ChatScope, peerId: string): ModelRoute | undefined {
    return this.modelResolver.getEffectiveRoute(this.sessionKey(scope, peerId));
  }

  /**
   * 切换模型（fork + 重建，对齐 dsh-TUI 的 switchModel）
   *
   * 1. 持久化 per-peer 偏好到隔离文件（重启后恢复）
   * 2. fork 当前会话的完整历史，作为新 agent 的 seed
   * 3. 创建全新 session（新 sessionId），seed 重放历史、agentOptions 传新模型
   * 4. dispose 旧 agent
   *
   * 通过切换 sessionId + 全新 agent 实例，避免 installModelSelection
   * 与 agent requestHeader 的优先级竞争，同时保留对话上下文。
   */
  async setModelOverride(scope: ChatScope, peerId: string, route: ModelRoute): Promise<void> {
    const key = this.sessionKey(scope, peerId);

    // 1. 持久化偏好（重启后恢复）
    this.modelResolver.setOverride(key, route);

    const record = this.sessions.get(key);
    if (!record) {
      // 无活跃 session，下次 getOrCreate 用新偏好创建
      console.log(`[im-qqbot] model pref saved (no active session): key=${key} → ${route.provider}/${route.model}`);
      return;
    }

    // 2. 动态获取 sessions 服务并 fork 完整历史（保留上下文）
    const sessionsService = this.getSessionsService();
    if (!sessionsService) {
      // 无 fork 服务，降级：销毁重建（下次 getOrCreate 新建）
      console.log(`[im-qqbot] fork unavailable, fallback to dispose: key=${key}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    let seed: readonly unknown[];
    try {
      seed = sessionsService.fork(record.agent.session).events;
    } catch (err) {
      // fork 失败，降级：销毁重建
      console.log(`[im-qqbot] fork failed, fallback to dispose: key=${key} err=${err instanceof Error ? err.message : String(err)}`);
      this.sessions.delete(key);
      record.agent.cancel({ kind: 'user' });
      await record.handle.dispose().catch(() => {});
      return;
    }

    const childId = SessionId(randomUUID());

    // 3. 创建新 agent（seed 重放 + 新模型）
    const composed = await this.composePreset(this.config.preset);
    const created = await this.agents.create({
      sessionId: childId,
      seed,
      meta: {
        cwd: this.config.cwd || process.cwd(),
        parentSession: record.sessionId,
        seedLength: seed.length,
        ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
      },
      agentOptions: route,
      ...(composed.setup ? { setup: composed.setup } : {}),
    });

    // 4. 记录新 sessionId（重启后可恢复 fork 后的会话）
    this.modelResolver.setSessionId(key, childId);

    // 5. 切换 record 到新 agent，dispose 旧 agent
    const oldHandle = record.handle;
    record.sessionId = childId;
    record.agent = created.agent;
    record.handle = created;
    record.agentPreset = composed.agentPreset;
    record.lastActivity = Date.now();

    void oldHandle.dispose().catch(() => {});
    console.log(`[im-qqbot] model switched via fork: key=${key} → ${route.provider}/${route.model} sessionId=${childId}`);
  }

  /**
   * 清除模型偏好（恢复默认）
   */
  clearModelOverride(scope: ChatScope, peerId: string): void {
    const key = this.sessionKey(scope, peerId);
    this.modelResolver.clearOverride(key);
    this.modelResolver.clearSessionId(key);
  }

  /**
   * 列出所有可用模型
   */
  listAvailableModels(): ModelEntry[] {
    return this.modelResolver.listModels();
  }

  /**
   * 列出可用 providers
   */
  listProviders(): string[] {
    return this.modelResolver.listProviders();
  }

  // ── Session 生命周期管理 ──

  /**
   * 生成 sessionKey
   */
  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  /**
   * 从 sessionKey 确定性生成 SessionId
   *
   * 作为初始 sessionId。模型切换（fork）后，会用新的 childId 覆盖
   * （见 currentSessionId / setModelOverride），重启后从偏好文件恢复。
   */
  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  /**
   * 获取指定 sessionKey 的当前 sessionId
   *
   * 优先返回 fork 后记录的 childId（持久化），否则回退到确定性派生值。
   */
  private currentSessionId(sessionKey: string): string {
    return this.modelResolver.getSessionId(sessionKey) ?? this.deriveSessionId(sessionKey);
  }

  /**
   * 组合 preset：解析 preset id 并生成 setup hook
   */
  private async composePreset(presetId?: string): Promise<PresetComposition> {
    let presets: AgentPresetsLike | undefined;
    try {
      presets = (this.ctx as unknown as Record<string, unknown>).agentPresets as AgentPresetsLike | undefined;
    } catch {
      // agentPresets 服务未注入，降级跳过
    }

    if (!presets) return {};

    try {
      const resolved = await presets.resolve(presetId);
      const resolvedId = resolved.id;
      return {
        agentPreset: resolvedId,
        setup: async (agentCtx: Context) => {
          await presets.mount(agentCtx, resolvedId);
        },
      };
    } catch (err) {
      this.logger.warn(
        `im-qqbot: preset ${presetId ?? '(default)'} unavailable: ${err instanceof Error ? err.message : String(err)} — using host composition`,
      );
      return {};
    }
  }

  /** 获取或恢复或创建会话（get → resume → create） */
  async getOrCreate(
    scope: ChatScope,
    peerId: string,
    senderId: string,
    replyTarget: ReplyTarget,
  ): Promise<SessionRecord> {
    const key = this.sessionKey(scope, peerId);
    const existing = this.sessions.get(key);

    if (existing) {
      existing.replyTarget = replyTarget;
      existing.lastActivity = Date.now();
      return existing;
    }

    const route = this.modelResolver.getEffectiveRoute(key);
    const sessionId = SessionId(this.currentSessionId(key));
    console.log(`[im-qqbot] getOrCreate: key=${key} route=${route ? `${route.provider}/${route.model}` : 'host-default'} sessionId=${sessionId}`);

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    // 1. 检查进程内是否已有活跃 agent
    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      console.log(`[im-qqbot] reusing live agent: key=${key}`);
    } else {
      // 2. 尝试从持久化存储恢复（resume 语义：尊重 session 自己的模型）
      try {
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const resumeRoute = this.modelResolver.getResumeRoute(key);
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          ...(resumeRoute ? { agentOptions: resumeRoute } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        console.log(`[im-qqbot] resumed session: key=${key} preset=${agentPreset ?? 'none'} route=${resumeRoute ? `${resumeRoute.provider}/${resumeRoute.model}` : 'session-own'}`);
      } catch {
        // 3. 恢复失败，创建全新 session（create 语义：用完整默认链）
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          ...(route ? { agentOptions: route } : {}),
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = created.agent;
        handle = created;
        console.log(`[im-qqbot] created new session: key=${key} preset=${agentPreset ?? 'none'}`);
      }
    }

    const record: SessionRecord = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      replyTarget,
      scope,
      peerId,
      senderId,
      lastActivity: Date.now(),
      agentPreset,
    };

    this.sessions.set(key, record);
    return record;
  }

  /** 根据 sessionId 查找 record */
  findBySessionId(sessionId: string): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.sessionId === sessionId) return record;
    }
    return undefined;
  }

  /** 根据 agent 查找 record */
  findByAgent(agent: DshAgent): SessionRecord | undefined {
    for (const record of this.sessions.values()) {
      if (record.agent === agent) return record;
    }
    return undefined;
  }

  /** 删除并销毁指定会话 */
  async remove(scope: ChatScope, peerId: string): Promise<void> {
    const key = this.sessionKey(scope, peerId);
    const record = this.sessions.get(key);
    if (!record) return;
    this.sessions.delete(key);
    this.modelResolver.clearSessionId(key);
    record.agent.cancel({ kind: 'user' });
    await record.handle.dispose().catch(() => {});
    console.log(`[im-qqbot] session removed: key=${key}`);
  }

  /** 定期回收闲置会话 */
  private evictIdle(): void {
    const now = Date.now();
    for (const [key, record] of this.sessions) {
      if (now - record.lastActivity > this.config.sessionIdleTimeout) {
        console.log(`[im-qqbot] evicting idle session: key=${key}`);
        this.sessions.delete(key);
        record.agent.cancel({ kind: 'user' });
        void record.handle.dispose().catch(() => {});
      }
    }
  }

  /** 关闭所有会话并释放资源 */
  async disposeAll(): Promise<void> {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
    const records = [...this.sessions.values()];
    this.sessions.clear();
    for (const record of records) {
      record.agent.cancel({ kind: 'user' });
    }
    await Promise.allSettled(records.map((r) => r.handle.dispose()));
    console.log(`[im-qqbot] all sessions disposed (count=${records.length})`);
  }

  /** 当前活跃会话数 */
  get size(): number {
    return this.sessions.size;
  }
}
