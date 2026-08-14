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
import { createHash } from 'node:crypto';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Context } from '@deepseek-ai/cordis';
import type { ChatScope, Logger, ReplyTarget } from './types.js';
import type { ImQQBotConfig } from './config.js';

/** AgentSetup hook 类型 */
export type AgentSetup = (agentCtx: Context) => Promise<void> | void;

/** dsh Agent 简化接口 */
export interface DshAgent {
  readonly id: string;
  readonly ctx: Context;
  cancel(cause: { kind: string }): void;
  followup(message: unknown): void;
  whenIdle(): Promise<void>;
}

export interface DshAgentHandle {
  agent: DshAgent;
  dispose(): Promise<void>;
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
    meta?: { cwd?: string; agentPreset?: string };
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

  constructor(
    private readonly ctx: Context,
    private readonly agents: DshAgentRegistry,
    private readonly config: ImQQBotConfig,
    private readonly logger: Logger,
  ) {
    if (config.sessionIdleTimeout > 0) {
      this.idleTimer = setInterval(() => this.evictIdle(), 60_000);
    }
  }

  /**
   * 生成 sessionKey
   *
   * 格式: qqbot:${appId}:${kind}:${peerId}
   */
  private sessionKey(scope: ChatScope, peerId: string): string {
    return `qqbot:${this.config.appId}:${scope}:${peerId}`;
  }

  /**
   * 从 sessionKey 确定性生成 SessionId
   */
  private deriveSessionId(sessionKey: string): string {
    const hash = createHash('sha256').update(sessionKey).digest('hex');
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
  }

  /**
   * 组合 preset：解析 preset id 并生成 setup hook
   *
   * 如果部署中没有 agent-presets 服务，返回空组合（使用宿主默认配置）
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

    const sessionId = SessionId(this.deriveSessionId(key));
    const route = {
      provider: this.config.provider || 'deepseek-official',
      model: this.config.model || 'deepseek-chat',
    };

    let agent: DshAgent;
    let handle: DshAgentHandle | undefined;
    let agentPreset: string | undefined;

    // 1. 检查进程内是否已有活跃 agent
    const live = this.agents.get(sessionId);
    if (live) {
      agent = live;
      console.log(`[im-qqbot] reusing live agent: key=${key}`);
    } else {
      // 2. 尝试从持久化存储恢复（带 setup hook）
      try {
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const resumed = await this.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: route,
          ...(composed.setup ? { setup: composed.setup } : {}),
        });
        agent = resumed.agent;
        handle = resumed;
        console.log(`[im-qqbot] resumed session: key=${key} preset=${agentPreset ?? 'none'}`);
      } catch {
        // 3. 恢复失败，创建全新 session（带 setup hook）
        const composed = await this.composePreset(this.config.preset);
        agentPreset = composed.agentPreset;
        const created = await this.agents.create({
          sessionId,
          meta: {
            cwd: this.config.cwd || process.cwd(),
            ...(agentPreset ? { agentPreset } : {}),
          },
          agentOptions: route,
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
