/**
 * QQ Bot 凭据初始化 — 扫码绑定
 *
 * 当 appId/appSecret 未配置时，通过 @tencent-connect/qqbot-connector
 * 唤起终端扫码流程获取凭据，并写入 dsh profile 配置。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    console.log(`\n 绑定成功！AppID: ${cred.appId}\n`);

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
      console.error('  export QQBOT_APPSECRET="你的AppSecret"');
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
 * 保证输出始终是合法 YAML。文件不存在或为空时安全重建；
 * 解析失败或结构异常时拒绝写入、保留原文件（避免覆盖用户其他配置）。
 */
export function persistCredentialsToProfile(
  credentials: SetupCredentials,
  profileDir?: string,
  logger?: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void },
): boolean {
  const log = logger ?? console;
  const dir = profileDir;
  if (!dir) {
    // 开发模式：插件从源码加载、不在 node_modules 下，无法定位 profile 目录
    printEnvInstructions(credentials);
    return false;
  }

  const patchPath = resolve(dir, 'cordis.patch.yml');

  try {
    // 1. 解析现有条目（文件不存在/为空才重建；解析失败会抛错，保留原文件）
    let entries: PatchEntry[] = [];
    if (existsSync(patchPath)) {
      entries = parsePatchEntries(readFileSync(patchPath, 'utf8'));
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
    //    先确保 profile 目录存在（文件不存在时也能正常创建，而非误入 ENOENT）
    const output = `# QQ Bot 凭据（扫码绑定自动生成）\n${yaml.dump(entries)}`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(patchPath, output, 'utf8');
    log.info(` 凭据已写入: ${patchPath}`);
    log.info(`  下次启动将自动使用保存的凭据`);
    return true;
  } catch (err) {
    log.warn(`写入配置失败: ${err instanceof Error ? err.message : String(err)}`);
    printYamlInstructions(credentials, patchPath);
    return false;
  }
}

/**
 * 解析 cordis.patch.yml 为条目数组
 *
 * - 空内容 / 仅注释（yaml.load 返回 null/undefined）→ 空数组（允许安全重建）
 * - 空数组 `[]` / 条目列表 → 过滤出含 id 的对象
 * - 非数组结构 / YAML 语法错误 → 抛错（由调用方保留原文件，避免覆盖用户其他配置）
 */
function parsePatchEntries(content: string): PatchEntry[] {
  if (!content.trim()) return [];

  const parsed = yaml.load(content);
  // 仅注释/空白 → null/undefined，等价于空文件，允许重建
  if (parsed === null || parsed === undefined) return [];
  if (!Array.isArray(parsed)) {
    throw new Error('cordis.patch.yml 顶层必须是 YAML 数组');
  }
  return parsed.filter(
    (e): e is PatchEntry =>
      typeof e === 'object' && e !== null && typeof (e as Record<string, unknown>).id === 'string',
  );
}

/** 开发模式引导：未定位到 profile 目录，引导用环境变量配置（console.log 确保可见） */
function printEnvInstructions(credentials: SetupCredentials): void {
  console.log('未检测到 profile 目录（开发模式），请通过环境变量配置凭据:');
  if (process.platform === 'win32') {
    // Windows CMD 语法（PowerShell 请用 $env:QQBOT_APPID="xxx"）
    console.log(`  set QQBOT_APPID=${credentials.appId}`);
    console.log(`  set QQBOT_APPSECRET=${credentials.appSecret}`);
  } else {
    console.log(`  export QQBOT_APPID="${credentials.appId}"`);
    console.log(`  export QQBOT_APPSECRET="${credentials.appSecret}"`);
  }
}

/** 正式安装引导：自动写入失败，引导手动在 cordis.patch.yml 配置（console.log 确保可见） */
function printYamlInstructions(credentials: SetupCredentials, patchPath: string): void {
  console.log('无法自动保存凭据，请手动打开以下文件添加配置:');
  console.log(`  ${patchPath}`);
  console.log('');
  console.log('  - id: im-qqbot');
  console.log('    config:');
  console.log(`      appId: "${credentials.appId}"`);
  console.log(`      appSecret: "${credentials.appSecret}"`);
}
