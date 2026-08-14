/**
 * OutboundBuffer — 出站文本缓冲
 *
 * 收集流式 chunk 并 debounce 发送，独立文件便于单测。
 */
import type { SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';
import { chunkMarkdownText } from './chunker.js';

/** QQ Bot 发送接口 */
export interface QQBotSender {
  sendMarkdown(target: ReplyTarget, content: string): Promise<unknown>;
}

export class OutboundBuffer {
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
