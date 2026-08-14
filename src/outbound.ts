/**
 * 出站处理器 — dsh session/event → QQ 消息发送
 */
import type { SessionManager, SessionRecord } from './session-manager.js';
import type { ImQQBotConfig } from './config.js';
import type { Logger, ReplyTarget } from './types.js';
import { chunkMarkdownText } from './chunker.js';

/** QQ Bot 发送接口 */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string): Promise<unknown>;
}

/** dsh SessionEvent 简化类型 */
export interface SessionEvent {
  type: string;
  data: Record<string, unknown>;
}

/** dsh Session 简化类型 */
export interface SessionLike {
  header: { id: string };
}

/**
 * 出站文本缓冲 — 收集流式 chunk 并 debounce 发送
 */
class OutboundBuffer {
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(
    private readonly record: SessionRecord,
    private readonly bot: QQBotSender,
    private readonly limit: number,
    private readonly logger: Logger,
  ) {}

  /** 追加文本增量 */
  append(text: string): void {
    this.buffer += text;
  }

  /** 获取当前累积文本 */
  get text(): string {
    return this.buffer;
  }

  /** 安排延迟发送（debounce） */
  scheduleSend(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delayMs);
  }

  /** 立即发送所有累积文本 */
  async flush(): Promise<void> {
    if (this.flushing || !this.buffer.trim()) return;
    this.flushing = true;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      const chunks = chunkMarkdownText(this.buffer, this.limit);
      for (const chunk of chunks) {
        await this.bot.sendMarkdown(this.record.replyTarget, chunk);
      }
    } catch (err) {
      this.logger.error(`im-qqbot: sendMarkdown failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.buffer = '';
      this.flushing = false;
    }
  }

  /** 取消未发送的定时器 */
  cancel(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.buffer = '';
  }
}

/**
 * 创建出站事件处理器
 *
 * 返回一个 handler 函数，应注册到 ctx.on('session/event', handler)
 */
export function createOutboundHandler(
  manager: SessionManager,
  bot: QQBotSender,
  config: ImQQBotConfig,
  logger: Logger,
): (session: SessionLike, event: SessionEvent) => void {
  const buffers = new Map<string, OutboundBuffer>();
  const limit = config.textChunkLimit;

  return (session: SessionLike, event: SessionEvent) => {
    const sessionId = session.header.id;
    const record = manager.findBySessionId(sessionId);
    if (!record) return; // 非本插件管理的会话

    switch (event.type) {
      case 'assistant/chunk': {
        handleChunk(sessionId, record, event, buffers, bot, limit, logger);
        break;
      }

      case 'assistant/message': {
        handleMessage(sessionId, record, event, buffers, bot, limit, logger);
        break;
      }

      case 'turn/end': {
        handleTurnEnd(sessionId, buffers, logger);
        break;
      }
    }
  };
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
  // 不实时发 chunk，等 assistant/message 完整输出后一起发
  // 如需流式体验，可改为 scheduleSend(500) 定期推送
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
  // 如果已有 buffer 积累了 chunk，直接用 buffer（chunk 更完整）
  const buffer = buffers.get(sessionId);
  if (buffer && buffer.text.trim()) {
    void buffer.flush();
    buffers.delete(sessionId);
    return;
  }

  // 否则从 message content 中提取文本
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
    // flush 任何残留
    if (buffer.text.trim()) {
      void buffer.flush();
    } else {
      buffer.cancel();
    }
    buffers.delete(sessionId);
  }
  logger.debug(`im-qqbot: turn/end sessionId=${sessionId}`);
}
