/**
 * 通用工具函数
 *
 * 纯函数与常量，供插件入口与其他模块复用。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PLUGIN_ROOT = resolve(__dirname, '../..');

/** 插件版本号（从 package.json 读取） */
const PLUGIN_VERSION = readPluginVersion();

function readPluginVersion(): string {
  try {
    const pkgPath = resolve(PLUGIN_ROOT, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * 构造 User-Agent 头
 *
 * 格式: dsh-qqbot/{version} (Node/{nodeVersion}; {platform})
 */
export function buildUserAgent(): string {
  return `dsh-qqbot/${PLUGIN_VERSION} (Node/${process.versions.node}; ${os.platform()})`;
}

/**
 * 从插件安装路径推导 profile 目录（node_modules 的父目录）
 *
 * 逐级向上查找名为 node_modules 的目录并返回其父目录。
 * 用 basename/dirname 而非字符串分隔符匹配，兼容 Windows（\）与 pnpm 嵌套结构。
 *
 * @param baseDir - 起始目录，缺省为插件根（可注入便于测试）
 */
export function getProfileDir(baseDir: string = PLUGIN_ROOT): string | null {
  let dir = baseDir;
  for (let i = 0; i < 32; i++) {
    if (basename(dir) === 'node_modules') return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
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
