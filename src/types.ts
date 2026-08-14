/**
 * dsh-im-qqbot 插件内部类型定义
 */

/** 会话作用域 */
export type ChatScope = 'c2c' | 'group';

/** QQ 回复目标 */
export interface ReplyTarget {
  scope: ChatScope;
  targetId: string;
  msgId?: string;
}

/** QQ 入站消息（简化） */
export interface QQInboundMessage {
  content?: string;
  senderId: string;
  groupOpenid?: string;
  replyTarget: ReplyTarget;
  attachments?: QQAttachment[];
}

/** QQ 附件 */
export interface QQAttachment {
  contentType: string;
  filename?: string;
  url?: string;
  size?: number;
}

/** 插件 Logger 接口 */
export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
}
