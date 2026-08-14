/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 复用 @tencent-connect/qqbot-nodejs SDK 全套中间件链。
 */
import type { Context } from '@deepseek-ai/cordis';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
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
import type { MiddlewareContext, SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';

import { ConfigSchema, type ImQQBotConfig } from './config.js';
import { SessionManager, type DshAgentRegistry } from './session-manager.js';
import { handleInbound } from './inbound.js';
import { createOutboundHandler } from './outbound.js';
import type { Logger } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');

/** 从插件安装路径推导 profile 目录（node_modules 的父目录） */
function getProfileDir(): string | null {
  const nmIdx = PLUGIN_ROOT.lastIndexOf('/node_modules/');
  if (nmIdx > 0) return PLUGIN_ROOT.slice(0, nmIdx);
  return null;
}

// ── Cordis 插件元数据 ──
export const name = 'im-qqbot';
export const inject = ['agents'];
export const Config = ConfigSchema;

export type { ImQQBotConfig } from './config.js';

import { runQrSetup, persistCredentialsToProfile } from './setup.js';

// ── 插件主体 ──
export async function apply(ctx: Context, config: ImQQBotConfig): Promise<void> {
  const agents = (ctx as unknown as Record<string, unknown>).agents as DshAgentRegistry;
  const logger: Logger = ((ctx as unknown as Record<string, unknown>).logger as Logger) ?? console;

  console.log('[im-qqbot] apply() called');

  let appId = resolveEnv(config.appId, 'QQBOT_APPID');
  let appSecret = resolveEnv(config.appSecret, 'QQBOT_SECRET');

  // ── 凭据缺失时唤起扫码绑定 ──
  if (!appId || !appSecret) {
    console.log('[im-qqbot] 凭据未配置，尝试扫码绑定...');
    const credentials = await runQrSetup();

    if (!credentials) {
      console.error('[im-qqbot] ERROR: 无法获取 QQ Bot 凭据，插件未启动');
      return;
    }

    // 持久化到 profile 配置
    persistCredentialsToProfile(credentials, getProfileDir() ?? undefined);

    // 写入环境变量供热更新后的下次 apply 读取
    process.env.QQBOT_APPID = credentials.appId;
    process.env.QQBOT_SECRET = credentials.appSecret;

    // 写入 cordis.patch.yml 会触发 dsh 热更新，自动重新加载本插件
    // 此处直接返回，避免与热更新产生竞态
    console.log('[im-qqbot] 配置已保存，等待热更新重新加载...');
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
  const bot = new QQBot({
    appId: config.appId,
    appSecret: config.appSecret,
    transport: 'websocket',
    logger,
  } as ConstructorParameters<typeof QQBot>[0]);
  console.log('[im-qqbot] QQBot SDK initialized');

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
        console.log(`[im-qqbot] Access blocked: ${reason}`);
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
    commands: buildCommands(manager, config),
  });
  bot.use(slash.middleware);

  // 9. 并发串行 + 消息合并（同 peer 排队，避免 session 冲突）
  bot.use(concurrencyGuard({
    strategy: 'merge',
    maxQueue: config.maxQueue,
    maxProcessingMs: config.processingTimeoutMs,
    urgentPredicate: (mCtx: MiddlewareContext) => {
      return (mCtx.message.content ?? '').trim() === '/stop';
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
      console.log('[im-qqbot] ← message (post-middleware):', JSON.stringify(msg, null, 2).slice(0, 500));
    }
    // 将中间件 state 中的 envelope/quote/history 传递给 inbound handler
    await handleInbound(msg, manager, config, logger, mCtx.state);
  });

  // ── 出站 ──
  const outboundHandler = createOutboundHandler(manager, bot, config, logger);
  (ctx as unknown as { on(event: string, handler: (...args: unknown[]) => void): void })
    .on('session/event', outboundHandler as (...args: unknown[]) => void);

  bot.on('error', (err: unknown) => {
    logger.error(`im-qqbot: bot error: ${err instanceof Error ? err.message : String(err)}`);
  });

  bot.on('ready', () => {
    console.log(`[im-qqbot] Bot ready! appId=${config.appId}`);
  });

  // ── 生命周期 ──
  (ctx as unknown as { effect(fn: () => (() => Promise<void>) | void, name?: string): void })
    .effect(() => {
      console.log(`[im-qqbot] Starting bot (appId=${config.appId})`);
      bot.start().catch((err: unknown) => {
        console.error(`[im-qqbot] Bot start failed: ${err instanceof Error ? err.message : String(err)}`);
      });

      return async () => {
        console.log('[im-qqbot] Shutting down');
        await manager.disposeAll();
        bot.stop();
      };
    }, 'im-qqbot.lifecycle');
}

// ── 斜杠命令定义 ──

function buildCommands(manager: SessionManager, _config: ImQQBotConfig) {
  return [
    {
      name: ['reset', 'clear'],
      description: '重置当前会话（清除上下文）',
      handler: (cmdCtx: SlashCommandHandlerContext) => {
        const msg = cmdCtx.message;
        const scope = msg.kind === 'group' ? 'group' : 'c2c';
        const peerId = scope === 'group'
          ? ((msg as unknown as Record<string, unknown>).groupOpenid as string ?? msg.senderId)
          : msg.senderId;
        void manager.remove(scope as 'c2c' | 'group', peerId);
        return '会话已重置 ✓';
      },
    },
    {
      name: 'model',
      description: '查看或切换模型（用法: /model [provider/model]）',
      handler: async (cmdCtx: SlashCommandHandlerContext) => {
        const msg = cmdCtx.message;
        const scope = msg.kind === 'group' ? 'group' : 'c2c';
        const peerId = scope === 'group'
          ? ((msg as unknown as Record<string, unknown>).groupOpenid as string ?? msg.senderId)
          : msg.senderId;
        const args = (cmdCtx.command?.raw ?? '').trim();

        // 无参数：显示当前模型 + 可用模型列表（可点击）
        if (!args) {
          const current = manager.getEffectiveModel(scope as 'c2c' | 'group', peerId);
          const models = manager.listAvailableModels();

          // 当前模型展示：优先用别名（name），找不到别名时回退到 provider/model id
          let currentDisplay = '宿主默认配置';
          if (current) {
            const matched = models.find((m) => m.provider === current.provider && m.id === current.model);
            currentDisplay = matched?.name ?? `${current.provider}/${current.model}`;
          }

          const lines: string[] = [
            '### 🤖 模型配置',
            '',
            `**当前模型:** ${currentDisplay}`,
          ];

          if (models.length > 0) {
            lines.push('', '**可用模型（点击切换）:**');
            for (const m of models) {
              const modelPath = `${m.provider}/${m.id}`;
              const displayName = m.name ? `${m.name}` : modelPath;
              lines.push(`<qqbot-cmd-input text="/model ${modelPath}" show="/model ${displayName}"/>`);
            }
          }

          lines.push(
            '',
            '手动指定: `/model provider/model`',
          );

          const bot = (cmdCtx as unknown as Record<string, unknown>).bot as { sendMarkdown(target: unknown, content: string): Promise<unknown> };
          const replyTarget = (cmdCtx as unknown as Record<string, unknown>).replyTarget;
          await bot.sendMarkdown(replyTarget, lines.join('\n'));
          return { kind: 'noop' as const };
        }

        // 解析 provider/model 格式
        let provider: string;
        let model: string;

        if (args.includes('/')) {
          const parts = args.split('/');
          provider = parts[0] ?? '';
          model = parts.slice(1).join('/');
        } else {
          // 仅指定 model 名，provider 从当前路由继承
          const current = manager.getEffectiveModel(scope as 'c2c' | 'group', peerId);
          provider = current?.provider ?? 'deepseek-official';
          model = args;
        }

        if (!provider || !model) {
          return '用法: /model provider/model\n示例: /model deepseek-official/deepseek-chat';
        }

        await manager.setModelOverride(scope as 'c2c' | 'group', peerId, { provider, model });
        return `✅ 模型已切换: ${provider}/${model}\n立即生效，对话上下文保留。`;
      },
    },
    {
      name: 'ping',
      description: '连通性测试',
      handler: () => 'pong 🏓',
    },
    {
      name: 'version',
      description: '查看版本信息',
      handler: () => {
        const current = manager.getEffectiveModel('c2c', '');
        const modelInfo = current ? `${current.provider}/${current.model}` : '宿主默认';
        return `dsh-qqbot v0.1.0 | model: ${modelInfo}`;
      },
    },
    {
      name: 'stop',
      description: '中止当前生成',
      hidden: true,
      handler: () => ({ kind: 'noop' as const }),
    },
  ];
}

// ── 工具函数 ──

function resolveEnv(configValue: string, envKey: string): string {
  if (configValue && configValue !== '__FROM_ENV__' && !configValue.startsWith('process.env')) {
    return configValue;
  }
  return process.env[envKey] ?? '';
}
