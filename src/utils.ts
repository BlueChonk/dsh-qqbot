/**
 * 通用工具函数
 *
 * 从 index.ts 抽离的纯函数与常量，供插件入口与 commands/ 目录复用。
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import type { SlashCommandHandlerContext } from '@tencent-connect/qqbot-nodejs';
import { chunkMarkdownText } from './chunker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '..');

/**
 * 从插件安装路径推导 profile 目录（node_modules 的父目录）
 */
export function getProfileDir(): string | null {
  const nmIdx = PLUGIN_ROOT.lastIndexOf('/node_modules/');
  if (nmIdx > 0) return PLUGIN_ROOT.slice(0, nmIdx);
  return null;
}

/**
 * 解析环境变量占位配置
 */
export function resolveEnv(configValue: string, envKey: string): string {
  if (configValue && configValue !== '__FROM_ENV__' && !configValue.startsWith('process.env')) {
    return configValue;
  }
  return process.env[envKey] ?? '';
}

/**
 * 从命令上下文提取 scope + peerId
 */
export function getScopePeer(cmdCtx: SlashCommandHandlerContext): { scope: 'c2c' | 'group'; peerId: string } {
  const msg = cmdCtx.message;
  const scope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group'
    ? ((msg as unknown as Record<string, unknown>).groupOpenid as string ?? msg.senderId)
    : msg.senderId;
  return { scope, peerId };
}

/**
 * 格式化相对时间
 */
export function formatRelativeTime(ts?: number): string {
  if (!ts) return '—';
  const diff = Date.now() - ts;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h 前`;
  return `${Math.floor(diff / 86_400_000)}d 前`;
}

/**
 * 分块发送 markdown（长内容自动切分）
 */
export async function sendMarkdownChunked(
  cmdCtx: SlashCommandHandlerContext,
  content: string,
  chunkLimit: number,
): Promise<void> {
  const bot = (cmdCtx as unknown as Record<string, unknown>).bot as { sendMarkdown(target: unknown, content: string): Promise<unknown> };
  const replyTarget = (cmdCtx as unknown as Record<string, unknown>).replyTarget;
  const chunks = chunkMarkdownText(content, chunkLimit);
  for (const chunk of chunks) {
    await bot.sendMarkdown(replyTarget, chunk);
  }
}
