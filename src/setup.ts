/**
 * QQ Bot 凭据初始化 — 扫码绑定
 *
 * 当 appId/appSecret 未配置时，通过 @tencent-connect/qqbot-connector
 * 唤起终端扫码流程获取凭据，并写入 dsh profile 配置。
 */
import { resolve } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { qrConnect } from '@tencent-connect/qqbot-connector';

/** 凭据结果 */
export interface SetupCredentials {
  appId: string;
  appSecret: string;
}

/**
 * 执行 QR 扫码绑定，获取 QQ Bot 凭据
 *
 * 使用动态 import 加载 qqbot-connector（可能未安装），
 * 在终端打印二维码等待用户扫码。
 */
export async function runQrSetup(source = 'dsh-qqbot'): Promise<SetupCredentials | null> {
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  QQ Bot 凭据未配置，启动扫码绑定');
  console.log('══════════════════════════════════════════════════════\n');

  try {
    console.log('请使用手机 QQ 扫描下方二维码完成绑定...\n');

    const credentials = await qrConnect({ source });

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
 * 在已有 `id: im-qqbot` 条目的 config 段中写入 appId/appSecret。
 * 写入后下次启动无需再次扫码。
 */
export function persistCredentialsToProfile(
  credentials: SetupCredentials,
  profileDir?: string,
): boolean {
  const dir = profileDir;
  if (!dir) {
    printManualInstructions(credentials);
    return false;
  }

  const patchPath = resolve(dir, 'cordis.patch.yml');

  try {
    let content: string;

    if (existsSync(patchPath)) {
      content = readFileSync(patchPath, 'utf8');

      if (content.trim() === '[]' || content.trim() === '') {
        // 空文件，写入完整条目
        content = buildPatchContent(credentials);
      } else if (content.includes('id: im-qqbot')) {
        // 已有 im-qqbot 条目
        if (content.includes('appId:')) {
          // 替换已有的 appId/appSecret
          content = content.replace(
            /appId:\s*.*/,
            `appId: '${credentials.appId}'`,
          );
          content = content.replace(
            /appSecret:\s*.*/,
            `appSecret: '${credentials.appSecret}'`,
          );
        } else {
          // config 段存在但没有 appId，在 config: 后插入
          content = content.replace(
            /(id: im-qqbot\s*\n\s*config:\s*\n)/,
            `$1    appId: '${credentials.appId}'\n    appSecret: '${credentials.appSecret}'\n`,
          );
        }
      } else {
        // 没有 im-qqbot 条目，追加
        content = content.trimEnd() + '\n' + buildPatchContent(credentials);
      }
    } else {
      content = buildPatchContent(credentials);
    }

    writeFileSync(patchPath, content, 'utf8');
    console.log(`[im-qqbot] ✔ 凭据已写入: ${patchPath}`);
    console.log(`[im-qqbot]   下次启动将自动使用保存的凭据\n`);
    return true;
  } catch (err) {
    console.warn(`[im-qqbot] 写入配置失败: ${err instanceof Error ? err.message : String(err)}`);
    printManualInstructions(credentials);
    return false;
  }
}

function printManualInstructions(credentials: SetupCredentials): void {
  console.warn('[im-qqbot] 无法自动保存凭据，请手动设置环境变量:');
  console.warn(`  export QQBOT_APPID="${credentials.appId}"`);
  console.warn(`  export QQBOT_SECRET="${credentials.appSecret}"`);
}

function buildPatchContent(creds: SetupCredentials): string {
  return `# QQ Bot 凭据（扫码绑定自动生成）
- id: im-qqbot
  config:
    appId: '${creds.appId}'
    appSecret: '${creds.appSecret}'
`;
}
