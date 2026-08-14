# @tencent-connect/dsh-qqbot

基于 [deepseek-harness](../deepseek-harness) (dsh) 的 QQ Bot IM 插件，将 QQ 消息平台作为 dsh agent 的前端协议驱动。

## 架构

```
QQ 用户 → QQ WebSocket → dsh-im-qqbot → ctx.agents → dsh agent loop → LLM
                                 ↑                           │
                                 └── session/event ──────────┘
                                       (assistant reply → QQ sendMarkdown)
```

## 安装

### 方式一：一键安装脚本

```bash
# 安装默认包最新版本
sh install.sh

# 指定版本
sh install.sh --version 0.2.0

# 指定包名
sh install.sh --pkg @myorg/my-qqbot-plugin

# 指定包名 + 版本
sh install.sh --pkg @myorg/my-qqbot-plugin --version 1.0.0

# 指定 npm registry
sh install.sh --registry https://registry.npmmirror.com

# 查看帮助
sh install.sh --help
```

脚本自动完成 dsh/pnpm 预检 + profile 初始化 + 插件注册。

### 方式二：手动执行

```bash
# 安装到 profile
dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot

# 配置环境变量
export QQBOT_APPID="你的AppID"
export QQBOT_SECRET="你的AppSecret"

# 启动
dsh --profile qqbot
```

### 方式三：本地路径安装

```bash
# 构建
cd /path/to/dsh-qqbot
pnpm install && pnpm build

# 安装到 profile（本地路径）
dsh plugin --profile qqbot add /path/to/dsh-qqbot

# 启动
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
dsh --profile qqbot
```

### 方式三：--patch 开发模式

```bash
cd /path/to/deepseek-harness
export QQBOT_APPID="你的AppID" QQBOT_SECRET="你的AppSecret"
pnpm dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

## 配置项

| 配置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `appId` | string | **必填** | QQ Bot AppID（或通过 `QQBOT_APPID` 环境变量） |
| `appSecret` | string | **必填** | QQ Bot AppSecret（或通过 `QQBOT_SECRET` 环境变量） |
| `provider` | string | `deepseek-official` | LLM 提供商名称 |
| `model` | string | `deepseek-chat` | 模型名称 |
| `preset` | string | - | Agent preset id |
| `cwd` | string | `process.cwd()` | Agent 工作目录 |
| `requireMention` | boolean | `true` | 群聊是否需要 @bot 才触发 |
| `groupPrompt` | string | - | 群聊额外 system prompt |
| `directPrompt` | string | - | 私聊额外 system prompt |
| `textChunkLimit` | number | `4500` | 单条消息最大字符数 |
| `sessionIdleTimeout` | number | `1800000` | 会话闲置超时(ms)，默认 30 分钟 |
| `debug` | boolean | `false` | 调试模式 |

## 内置命令

| 命令 | 说明 |
|------|------|
| `/reset` | 重置当前会话（清除上下文） |
| `/clear` | 同 `/reset` |

## 核心模块

```
src/
├── index.ts              # Cordis 插件入口（async apply）
├── config.ts             # 配置 Schema
├── session-manager.ts    # QQ peer → Agent 映射（get → resume → create）
├── inbound.ts            # QQ 入站消息 → agent.followup()
├── outbound.ts           # session/event → QQ sendMarkdown
├── mention.ts            # @mention 检测/清理
├── chunker.ts            # Markdown 文本切分（代码块/表格感知）
└── types.ts              # 内部类型定义
```

## 会话路由

sessionKey 格式: `qqbot:${appId}:${kind}:${peerId}`

- c2c (私聊): `qqbot:102901613:c2c:B9CE1DEEC46B...`
- group (群聊): `qqbot:102901613:group:16FA861B01EE...`

SessionId 由 sessionKey 确定性派生（SHA-256），保证同一用户/群的消息始终路由到同一 agent，重启后可恢复会话。

会话解析策略（三级降级）：
1. **进程内复用** — `agents.get(sessionId)`
2. **持久化恢复** — `agents.resume({ resumeSessionId, setup })`
3. **全新创建** — `agents.create({ sessionId, meta, setup })`

## 设计原则

- **纯 Cordis 插件** — 遵循 dsh "Plugins, not loop changes" 原则
- **声明式依赖** — `inject = ['agents']`，不直接耦合其他插件
- **会话隔离** — 每个 QQ 私聊用户/群聊各一个独立 Agent
- **Preset 支持** — 可通过 `agent-presets` 服务挂载预设（工具集、prompt 等）
- **闲置回收** — 超时自动 dispose Agent，防止内存泄漏
- **Markdown 输出** — 回复以 Markdown 格式发送，支持代码块/表格感知切分

## 本地开发

```bash
# 安装依赖
pnpm install

# 构建
pnpm build

# 开发模式（watch）
pnpm dev

# 用 --patch 方式调试（在 dsh monorepo 中）
cd /path/to/deepseek-harness
export QQBOT_APPID="xxx" QQBOT_SECRET="xxx"
pnpm dsh web --patch /path/to/dsh-qqbot/cordis.dev.yml
```

### 断点调试

```bash
node --inspect ./node_modules/.bin/dsh --profile headless \
  --patch /path/to/dsh-qqbot/cordis.dev.yml
```

### VS Code launch.json

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "dsh + qqbot (patch)",
      "type": "node",
      "request": "launch",
      "cwd": "/path/to/deepseek-harness",
      "runtimeExecutable": "pnpm",
      "runtimeArgs": ["dsh", "web", "--patch", "/path/to/dsh-qqbot/cordis.dev.yml"],
      "env": {
        "QQBOT_APPID": "你的AppID",
        "QQBOT_SECRET": "你的AppSecret",
        "DEEPSEEK_API_KEY": "sk-xxx"
      },
      "console": "integratedTerminal"
    }
  ]
}
```

## 发布

```bash
pnpm build
npm publish --access public
```

安装后用户通过以下命令添加到 dsh：

```bash
dsh plugin --profile qqbot add @tencent-connect/dsh-qqbot
```
