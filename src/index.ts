/**
 * dsh-im-qqbot — QQ Bot IM channel plugin for deepseek-harness
 *
 * Cordis 插件入口。将 QQ 消息平台作为 dsh 的前端协议驱动。
 * 网关组装（中间件编排 + 事件 + 出站 + 生命周期）见 src/gateway/。
 */
import type { Context } from '@deepseek-ai/cordis';
import { ConfigSchema, type ImQQBotConfig } from './config.js';
import { bootstrapGateway } from './gateway/index.js';
import type { DshAgentRegistry } from './session/index.js';
import { getProfileDir, resolveEnv } from './shared/index.js';
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

  await bootstrapGateway(ctx, agents, resolvedConfig, logger);
}
