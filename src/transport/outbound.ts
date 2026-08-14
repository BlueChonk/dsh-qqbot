/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 */
import type { SessionManager, SessionRecord } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
import { chunkMarkdownText } from './chunker.js';
import { OutboundBuffer, type QQBotSender } from './outbound-buffer.js';
import { formatToolResult, type ToolsRegistryLike, type ToolResultData } from './tool-presenter.js';

export type { QQBotSender } from './outbound-buffer.js';
export type { ToolsRegistryLike } from './tool-presenter.js';

/** dsh SessionEvent 简化类型 */
export interface SessionEvent {
  type: string;
  data: Record<string, unknown>;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/** 工具调用记录（tool/call 建立，tool/result 消费） */
interface ToolCallRecord {
  name: string;
  args: string;
}

/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)。
 * toolsRegistry 用于工具结果的结构化展示（参考 dsh-TUI 的 presentResult）。
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
  toolsRegistry?: ToolsRegistryLike,
): (session: SessionLike, event: SessionEvent) => void {
  const buffers = new Map<string, OutboundBuffer>();
  const toolCalls = new Map<string, ToolCallRecord>();
  const limit = config.textChunkLimit;

  return (session: SessionLike, event: SessionEvent) => {
    const sessionId = session.header.id;
    const record = manager.findBySessionId(sessionId);
    if (!record) return;

    switch (event.type) {
      case 'assistant/chunk': {
        handleChunk(sessionId, record, event, buffers, bot, limit, logger);
        break;
      }

      case 'assistant/message': {
        handleMessage(sessionId, record, event, buffers, bot, limit, logger);
        break;
      }

      case 'tool/call': {
        handleToolCall(event, toolCalls);
        break;
      }

      case 'tool/result': {
        handleToolResult(record, event, toolCalls, bot, config, logger, toolsRegistry);
        break;
      }

      case 'turn/end': {
        handleTurnEnd(sessionId, buffers, logger);
        break;
      }
    }
  };
}

/** 记录工具调用（不发送，避免刷屏，等待结果） */
function handleToolCall(event: SessionEvent, toolCalls: Map<string, ToolCallRecord>): void {
  const data = event.data as { callId?: string; name?: string; arguments?: string };
  if (!data.callId || !data.name) return;
  toolCalls.set(data.callId, { name: data.name, args: data.arguments ?? '' });
}

/** 格式化并发送工具结果（错误始终发送，成功结果按开关） */
function handleToolResult(
  record: SessionRecord,
  event: SessionEvent,
  toolCalls: Map<string, ToolCallRecord>,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
  toolsRegistry: ToolsRegistryLike | undefined,
): void {
  const data = event.data as {
    message?: { source?: { callId?: string } };
    error?: { name: string; code: string };
  };
  const callId = data.message?.source?.callId;
  if (!callId) return;

  const call = toolCalls.get(callId);
  toolCalls.delete(callId);
  if (!call) return;

  // 错误始终展示，成功结果按 config.showToolResults
  if (data.error === undefined && !config.showToolResults) return;

  const text = formatToolResult(
    call.name,
    call.args,
    event.data as unknown as ToolResultData,
    toolsRegistry,
    record.agent,
  );
  if (!text) return;

  void (async () => {
    const chunks = chunkMarkdownText(text, config.textChunkLimit);
    for (const chunk of chunks) {
      try {
        await bot.sendMarkdown(record.replyTarget, chunk);
      } catch (err) {
        logger.error(`im-qqbot: sendToolResult failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();
}

/** 处理流式文本增量 */
function handleChunk(
  sessionId: string,
  record: SessionRecord,
  event: SessionEvent,
  buffers: Map<string, OutboundBuffer>,
  bot: QQBotSender,
  limit: number,
  logger: Logger,
): void {
  const chunk = (event.data as { chunk?: { type?: string; text?: string } }).chunk;
  if (!chunk || chunk.type !== 'text-delta' || !chunk.text) return;

  let buffer = buffers.get(sessionId);
  if (!buffer) {
    buffer = new OutboundBuffer(record, bot, limit, logger);
    buffers.set(sessionId, buffer);
  }

  buffer.append(chunk.text);
}

/** 处理完整 assistant 消息 */
function handleMessage(
  sessionId: string,
  record: SessionRecord,
  event: SessionEvent,
  buffers: Map<string, OutboundBuffer>,
  bot: QQBotSender,
  limit: number,
  logger: Logger,
): void {
  const buffer = buffers.get(sessionId);
  if (buffer && buffer.text.trim()) {
    void buffer.flush();
    buffers.delete(sessionId);
    return;
  }

  const message = event.data as { message?: { content?: Array<{ type: string; text?: string }> } };
  const blocks = message?.message?.content;
  if (!blocks || !Array.isArray(blocks)) return;

  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text) {
      textParts.push(block.text);
    }
  }

  const fullText = textParts.join('\n');
  if (!fullText.trim()) return;

  const chunks = chunkMarkdownText(fullText, limit);
  void (async () => {
    for (const chunk of chunks) {
      try {
        await bot.sendMarkdown(record.replyTarget, chunk);
      } catch (err) {
        logger.error(`im-qqbot: sendMarkdown failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  })();

  buffers.delete(sessionId);
}

/** 处理轮次结束，清理 buffer */
function handleTurnEnd(
  sessionId: string,
  buffers: Map<string, OutboundBuffer>,
  logger: Logger,
): void {
  const buffer = buffers.get(sessionId);
  if (buffer) {
    if (buffer.text.trim()) {
      void buffer.flush();
    } else {
      buffer.cancel();
    }
    buffers.delete(sessionId);
  }
  logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
}
