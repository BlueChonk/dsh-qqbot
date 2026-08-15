/**
 * QQ Bot 凭据初始化 — 扫码绑定
 *
 * 当 appId/appSecret 未配置时，通过 @tencent-connect/qqbot-connector
 * 唤起终端扫码流程获取凭据，并写入 dsh profile 配置。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { startQrConnect } from '@tencent-connect/qqbot-connector';
import type { QrConnectCredentials } from '@tencent-connect/qqbot-connector';

/** 凭据结果 */
export interface SetupCredentials {
  appId: string;
  appSecret: string;
}

/** cordis.patch.yml 中的 patch 条目 */
interface PatchEntry {
  id?: string;
  config?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 终端可点击的 OSC 8 超链接（不支持 OSC 8 的终端会忽略控制序列，退化为纯 URL 文本） */
function clickableLink(url: string): string {
  return `\u001b]8;;${url}\u001b\\${url}\u001b]8;;\u001b\\`;
}

/**
 * 执行 QR 扫码绑定，获取 QQ Bot 凭据
 *
 * 在终端打印二维码等待用户扫码；同时输出扫码 URL，
 * 供二维码因系统字符问题渲染错位时点击/复制到浏览器打开扫码。
 */
export async function runQrSetup(source = 'dsh-qqbot'): Promise<SetupCredentials | null> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  QQ Bot 凭据未配置，启动扫码绑定');
  console.log('══════════════════════════════════════════════════════\n');

  try {
    console.log('请使用手机 QQ 扫描下方二维码完成绑定...\n');

    // 回调风格：onQrDisplayed 会在二维码打印后、轮询开始前回调扫码 URL，
    // 让用户在二维码错位时也能通过链接打开扫码页（二维码过期刷新会再次触发）。
    const credentials = await new Promise<QrConnectCredentials[]>((resolve, reject) => {
      startQrConnect(
        {
          onSuccess: resolve,
          onFailure: reject,
          onQrDisplayed: (url) => {
            console.log('二维码显示异常？点击下方链接，用浏览器打开即可完成扫码:');
            console.log(`  ${clickableLink(url)}\n`);
          },
          onQrExpired: () => {
            console.log('二维码已过期，正在刷新…\n');
          },
        },
        { source },
      );
    });

    if (!credentials || credentials.length === 0) {
      console.error('[im-qqbot] 扫码未返回凭据');
      return null;
    }

    const cred = credentials[0];
    if (!cred) {
      console.error('[im-qqbot] 扫码未返回有效凭据');
      return null;
    }
    console.log(`\n✔ 绑定成功！AppID: ${cred.appId}\n`);

    return {
      appId: cred.appId,
      appSecret: cred.appSecret,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('Cannot find') || msg.includes('ERR_MODULE_NOT_FOUND')) {
      console.error('[im-qqbot] @tencent-connect/qqbot-connector 未安装，无法扫码绑定');
      console.error('[im-qqbot] 请通过环境变量配置:');
      console.error('  export QQBOT_APPID="你的AppID"');
      console.error('  export QQBOT_SECRET="你的AppSecret"');
    } else {
      console.error(`[im-qqbot] 扫码绑定失败: ${msg}`);
    }

    return null;
  }
}

/**
 * 将凭据写入 dsh profile 的 cordis.patch.yml
 *
 * 用 js-yaml 解析现有文件后更新/追加 im-qqbot 条目，再 dump 写回，
 * 保证输出始终是合法 YAML。兼容空数组 `[]`、条目列表，以及
 * `[]` 与条目混合导致解析失败等异常情况（失败时重建）。
 */
export function persistCredentialsToProfile(
  credentials: SetupCredentials,
  profileDir?: string,
  logger?: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
): boolean {
  const log = logger ?? console;
  const dir = profileDir;
  if (!dir) {
    printManualInstructions(credentials);
    return false;
  }

  const patchPath = resolve(dir, 'cordis.patch.yml');

  try {
    // 1. 解析现有条目（容错处理）
    let entries: PatchEntry[] = [];
    if (existsSync(patchPath)) {
      entries = parsePatchEntries(readFileSync(patchPath, 'utf8'), log);
    }

    // 2. 查找已有 im-qqbot 条目
    const existing = entries.find((e) => e.id === 'im-qqbot');

    if (existing) {
      // 更新已有条目的 config
      existing.config = {
        ...(existing.config ?? {}),
        appId: credentials.appId,
        appSecret: credentials.appSecret,
      };
    } else {
      // 追加新条目
      entries.push({
        id: 'im-qqbot',
        config: {
          appId: credentials.appId,
          appSecret: credentials.appSecret,
        },
      });
    }

    // 3. dump 写回（保证合法 YAML）
    const output = `# QQ Bot 凭据（扫码绑定自动生成）\n${yaml.dump(entries)}`;
    writeFileSync(patchPath, output, 'utf8');
    log.info(`✔ 凭据已写入: ${patchPath}`);
    log.info(`  下次启动将自动使用保存的凭据`);
    return true;
  } catch (err) {
    log.warn(`写入配置失败: ${err instanceof Error ? err.message : String(err)}`);
    printManualInstructions(credentials);
    return false;
  }
}

/**
 * 解析 cordis.patch.yml 为条目数组
 *
 * 容错处理：
 * - 空内容 / 空数组 `[]` → 空数组
 * - 条目列表 → 过滤出含 id 的对象
 * - 解析失败（如 `[]` 与条目混合的多文档）→ 返回空数组（重建）
 */
function parsePatchEntries(
  content: string,
  log: { warn(msg: string, ...args: unknown[]): void },
): PatchEntry[] {
  if (!content.trim()) return [];

  try {
    const parsed = yaml.load(content);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (e): e is PatchEntry =>
          typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).id === 'string',
      );
    }
    return [];
  } catch (err) {
    log.warn(
      `cordis.patch.yml 解析失败，将重建: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function printManualInstructions(credentials: SetupCredentials): void {
  console.log('无法自动保存凭据，请手动设置环境变量:');
  console.log(`  export QQBOT_APPID="${credentials.appId}"`);
  console.log(`  export QQBOT_SECRET="${credentials.appSecret}"`);
}
