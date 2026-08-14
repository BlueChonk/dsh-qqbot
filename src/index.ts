/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 复用 @tencent-connect/qqbot-nodejs SDK 全套中间件链。
 */
import type { Context } from '@deepseek-ai/cordis';
import {
  QQBot,
  errorHandler,
  messageFilter,
  accessPolicy,
  mentionGate,
  contentSanitizer,
  rateLimiter,
  slashCommand,
  concurrencyGuard,
  typingIndicator,
  quoteRef,
  historyBuffer,
  envelopeFormatter,
  MemoryHistoryStore,
} from '@tencent-connect/qqbot-nodejs';
import type { MiddlewareContext } from '@tencent-connect/qqbot-nodejs';

import { ConfigSchema, type ImQQBotConfig } from './config.js';
import { SessionManager, type DshAgentRegistry } from './session/index.js';
import { handleInbound, createOutboundHandler } from './transport/index.js';
import type { ToolsRegistryLike } from './transport/tool-presenter.js';
import { buildCommandList } from './commands/index.js';
import { getProfileDir, resolveEnv, buildUserAgent } from './shared/index.js';
import { runQrSetup, persistCredentialsToProfile } from './setup.js';
import type { Logger } from './types.js';

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents'];
export const Config = ConfigSchema;

export type { ImQQBotConfig } from './config.js';

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  console.log('[im-qqbot] apply() called');

  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');

  // ── 凭据缺失时唤起扫码绑定 ──
  if (!appId || !appSecret) {
    logger.info('凭据未配置，尝试扫码绑定...');
    const credentials = await runQrSetup();

    if (!credentials) {
      logger.error('无法获取 QQ Bot 凭据，插件未启动');
      return;
    }

    // 持久化到 profile 配置
    persistCredentialsToProfile(credentials, getProfileDir() ?? undefined, logger);

    // 写入环境变量供热更新后的下次 apply 读取
    process.env.QQBOT_APPID = credentials.appId;
    process.env.QQBOT_SECRET = credentials.appSecret;

    // 写入 cordis.patch.yml 会触发 dsh 热更新，自动重新加载本插件
    // 此处直接返回，避免与热更新产生竞态
    logger.info('配置已保存，等待热更新重新加载...');
    return;
  }

  const resolvedConfig: ImQQBotConfig = { ...config, appId, appSecret };

  await bootstrap(ctx, agents, resolvedConfig, logger);
}

async function bootstrap(
  ctx: Context,
  agents: DshAgentRegistry,
  config: ImQQBotConfig,
  logger: Logger,
): Promise<void> {
  const manager = new SessionManager(ctx, agents, config, logger);

  // ── 初始化 QQ Bot SDK ──
  const userAgent = buildUserAgent();
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    userAgent,
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  logger.info(`QQBot SDK initialized (UA: ${userAgent})`);

  // ══════════════════════════════════════════════════════════════
  // SDK 中间件链（洋葱模型，按执行顺序编排）
  // ══════════════════════════════════════════════════════════════

  // 1. 错误兜底（最外层洋葱皮）
  bot.use(errorHandler());

  // 2. 消息过滤：bot 回声 + 消息去重
  bot.use(messageFilter({ skipSelfEcho: false }));

  // 3. 访问控制（白名单/开放/禁用）
  bot.use(accessPolicy({
    c2c: {
      mode: config.access.c2cMode,
      allow: config.access.c2cAllow.length > 0 ? config.access.c2cAllow : ['*'],
    },
    group: {
      mode: config.access.groupMode,
      allow: config.access.groupAllow.length > 0 ? config.access.groupAllow : ['*'],
    },
    onBlock: (_mCtx, reason) => {
      if (config.debug) {
        logger.debug(`Access blocked: ${reason}`);
      }
    },
  }));

  // 4. 群历史缓冲 — 放在门控之前，确保所有消息（含未 @bot）都计入上下文
  const historyStore = new MemoryHistoryStore();
  bot.use(historyBuffer({
    limit: config.historyLimit,
    store: historyStore,
    recordOnSkip: true,
  }));

  // 5. 群聊 @bot 门控
  bot.use(mentionGate({
    requireMentionInGroup: config.requireMention,
  }));

  // 6. 内容清洗（去 @marker、表情标签、多余空白）
  bot.use(contentSanitizer({
    parseFaceTags: true,
  }));

  // 7. 三层限流（sender / group / global）
  bot.use(rateLimiter());

  // 8. 斜杠命令（在 concurrencyGuard 之前，命令匹配后不排队直接响应）
  const slash = slashCommand({
    autoHelp: true,
    commands: buildCommandList({ manager, config }),
  });
  bot.use(slash.middleware);

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    urgentPredicate: (mCtx: MiddlewareContext) => {
      return (mCtx.message.content ?? '').trim() === '/bot-stop';
    },
  }));

  // 10. C2C 输入状态指示
  bot.use(typingIndicator());

  // 11. 引用消息解析（记录 + 解析被引用原文）
  bot.use(quoteRef({
    maxSize: 500,
    preferMsgElements: true,
  }));

  // 12. 上下文组装（将 history + quote + sender 组成 envelope）
  bot.use(envelopeFormatter({
    historyLimit: config.historyLimit,
    includeQuote: true,
    includeSender: true,
  }));

  // ══════════════════════════════════════════════════════════════
  // 最终处理：经过中间件链后的消息交给 dsh agent
  // ══════════════════════════════════════════════════════════════

  bot.on('message', async (mCtx: MiddlewareContext) => {
    const msg = mCtx.message;
    if (config.debug) {
      logger.debug(`← message (post-middleware): ${JSON.stringify(msg, null, 2).slice(0, 500)}`);
    }
    await handleInbound(msg, manager, config, logger, mCtx.state);
  });

  // ── 出站 ──
  // 获取 tools 服务（工具结果结构化展示，参考 dsh-TUI presentResult），可选
  let toolsRegistry: ToolsRegistryLike | undefined;
  try {
    toolsRegistry = ctx.get('tools') as ToolsRegistryLike | undefined;
  } catch {
    toolsRegistry = undefined;
  }

  const outboundHandler = createOutboundHandler(manager, bot, config, logger, toolsRegistry);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outboundHandler as (...args: unknown[]) => void);

  bot.on('error', (err: unknown) => {
    logger.error(`bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      logger.info(`Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        logger.error(`Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        logger.info('Shutting down');
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}
