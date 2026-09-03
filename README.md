# dsh-qqbot

基于 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) 的 QQ Bot 插件，将 DeepSeek AI 助手接入 QQ 私聊与群聊。

## 安装

```bash
npx @deepseek-ai/dsh plugin --profile qqbot add "github:BlueChonk/dsh-qqbot"
npx @deepseek-ai/dsh --profile qqbot
```

首次启动未配置凭据时，自动进入扫码引导：终端输出二维码 → 手机 QQ 扫码绑定 → 凭据自动保存到 profile，后续启动无需再次扫码。

## 配置

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | 必填 | QQ Bot AppID（或 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | 必填 | QQ Bot AppSecret（或 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `debug` | boolean | `false` | 调试模式 |

## 内置命令

| 命令 | 说明 |
|------|------|
| `/new`（`/reset` `/clear`） | 开始新会话 |
| `/compact` | 压缩会话历史 |
| `/model` | 查看或切换模型 |
| `/preset` | 查看或切换 agent preset |
| `/stop` | 中止当前生成 |
| `/bot-ping` | 连通性测试 |
| `/bot-version` | 查看版本信息 |
| `/bot-status` | 查看当前会话状态 |
| `/bot-help` | 查看所有指令 |

## 开发

```bash
pnpm install
pnpm build
pnpm dev  # watch 模式
```

## License

[MIT](./LICENSE)
