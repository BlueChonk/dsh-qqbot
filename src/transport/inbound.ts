/**
 * 入站处理器 — 经 SDK 中间件链处理后的消息 → dsh Agent followup
 *
 * 对齐 openclaw-qqbot body-assembler 的内容组装逻辑：
 * - Layer 1: userContent（文本 + 语音转录 + 附件描述）
 * - Layer 2: quotePart（引用消息块）
 * - Layer 3: userMessage（带发送者标签）
 * - Layer 4: dynamicCtx（媒体元数据）
 * - Layer 5: agentBody（history + base 拼合）
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import type { SessionManager } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { ChatScope, Logger, ReplyTarget } from '../types.js';

// ── 类型定义 ──

interface Attachment {
  content_type: string;
  filename: string;
  size: number;
  url: string;
  asr_refer_text?: string;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface ProcessedMessage {
  rawEventType: string;
  kind: 'c2c' | 'group';
  senderId: string;
  content: string;
  messageId: string;
  timestamp: string;
  groupOpenid?: string;
  msgType?: number;
  attachments?: Attachment[];
  [key: string]: unknown;
}

interface ResolvedQuote {
  text?: string;
  entry?: { senderId?: string; content?: string };
  attachments?: { contentType?: string; url?: string; filename?: string; asrText?: string }[];
}

interface HistoryEntry {
  senderId: string;
  senderName?: string;
  content: string;
  timestamp: number;
  messageId: string;
}

interface MentionState {
  wasMentioned?: boolean;
}

interface MiddlewareState {
  quote?: ResolvedQuote;
  history?: HistoryEntry[];
  envelope?: string;
  mention?: MentionState;
  processedAttachments?: ProcessedAttachment[];
  [key: string]: unknown;
}

interface ProcessedAttachment {
  type: 'voice' | 'image' | 'video' | 'file' | 'unknown';
  filename?: string;
  url?: string;
  localPath?: string;
  voiceText?: string;
  voiceSource?: 'stt' | 'asr' | 'fallback';
  duration?: number;
  width?: number;
  height?: number;
  size?: number;
}

// ── 主处理函数 ──

/**
 * 处理 QQ 入站消息（已经过 SDK 中间件链）
 */
export async function handleInbound(
  rawMsg: unknown,
  manager: SessionManager,
  _config: ImQQBotConfig,
  logger: Logger,
  state?: Record<string, unknown>,
): Promise<void> {
  const msg = rawMsg as ProcessedMessage;
  const mwState = (state ?? {}) as MiddlewareState;

  const scope: ChatScope = msg.kind === 'group' ? 'group' : 'c2c';
  const peerId = scope === 'group' ? (msg.groupOpenid ?? msg.senderId) : msg.senderId;

  const replyTarget: ReplyTarget = {
    scope,
    targetId: peerId,
    msgId: msg.messageId,
  };

  // ── 组装 agentBody（对齐 openclaw-qqbot body-assembler） ──
  const agentBody = assembleAgentBody(msg, mwState, scope, logger);

  if (!agentBody) return;

  logger.info(`Processing: scope=${scope} peerId=${peerId} body="${agentBody.slice(0, 200)}"`);

  // ── 获取或创建会话 ──
  let record;
  try {
    record = await manager.getOrCreate(scope, peerId, msg.senderId, replyTarget);
  } catch (err) {
    logger.error(`ERROR creating session: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // ── 构建 UserMessage → followup ──
  const content: ContentBlock[] = [{ type: 'text' as const, text: agentBody }];

  const message = createUserMessage({
    content,
    source: { kind: 'user' as const },
  });

  record.agent.followup(message);
  logger.info(`→ followup sent: key=${scope}:${peerId}`);
}

// ══════════════════════════════════════════════════════════════
// Body Assembly（对齐 openclaw-qqbot 5 层组装）
// ══════════════════════════════════════════════════════════════

/**
 * 组装 agentBody — AI 实际看到的完整上下文
 */
function assembleAgentBody(
  msg: ProcessedMessage,
  state: MiddlewareState,
  scope: ChatScope,
  logger: Logger,
): string | null {
  const userContent = buildUserContent(msg, state, logger);

  if (!userContent && (!msg.attachments || msg.attachments.length === 0)) return null;

  const quotePart = buildQuotePart(state.quote);

  const isGroup = scope === 'group';
  const wasMentioned = state.mention?.wasMentioned ?? false;
  const userMessage = buildUserMessage(userContent, quotePart, msg.senderId, isGroup, wasMentioned);

  const dynamicCtx = buildDynamicCtx(msg, state);

  const base = dynamicCtx ? `${dynamicCtx}${userMessage}` : userMessage;
  const agentBody = buildAgentBody(base, state.history, isGroup, wasMentioned);

  return agentBody;
}

/**
 * Layer 1: 用户文本内容 + 语音 + 附件
 */
function buildUserContent(msg: ProcessedMessage, state: MiddlewareState, logger: Logger): string {
  const parts: string[] = [];

  const text = (msg.content ?? '').trim();
  if (text) {
    parts.push(text);
  }

  const voiceTexts = extractVoiceTexts(msg.attachments, state.processedAttachments, logger);
  if (voiceTexts.length > 0) {
    for (const vt of voiceTexts) {
      const durationTag = vt.duration ? ` (${vt.duration}s)` : '';
      parts.push(`[Voice message${durationTag}] ${vt.text}`);
    }
  }

  const otherAttachments = describeAttachments(msg.attachments, state.processedAttachments);
  if (otherAttachments) {
    parts.push(otherAttachments);
  }

  return parts.join('\n');
}

/**
 * Layer 2: 引用消息块
 */
function buildQuotePart(quote?: ResolvedQuote): string {
  if (!quote?.text && !quote?.entry?.content) return '';

  const quoteText = quote.text || quote.entry?.content || 'Original content unavailable';

  return `[Quoted message begins]\n${quoteText}\n[Quoted message ends]\n[Current message]\n`;
}

/**
 * Layer 3: 带发送者标签的用户消息
 */
function buildUserMessage(
  userContent: string,
  quotePart: string,
  senderId: string,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup) {
    return `${quotePart}${userContent}`;
  }

  const mentionTag = wasMentioned ? ' (@you)' : '';
  const senderTag = `[${senderId.slice(0, 8)} (${senderId})]`;
  return `${quotePart}${senderTag} ${userContent}${mentionTag}`;
}

/**
 * Layer 4: 媒体元数据上下文
 */
function buildDynamicCtx(msg: ProcessedMessage, state: MiddlewareState): string {
  const lines: string[] = [];

  if (!msg.attachments || msg.attachments.length === 0) return '';

  const images = msg.attachments.filter(a => a.content_type === 'image');
  if (images.length > 0) {
    const urls = images.map(a => a.url).filter(Boolean);
    if (urls.length > 0) {
      lines.push(`- Images: ${urls.join(', ')}`);
    }
  }

  const voices = msg.attachments.filter(a => a.content_type === 'voice');
  if (voices.length > 0) {
    const urls = voices.map(a => a.url).filter(Boolean);
    if (urls.length > 0) {
      lines.push(`- Voice: ${urls.join(', ')}`);
    }
    const asrTexts = voices.map(a => a.asr_refer_text).filter(Boolean);
    if (asrTexts.length > 0) {
      lines.push(`- ASR: ${asrTexts.join(' | ')}`);
    }
  }

  const videos = msg.attachments.filter(a => a.content_type === 'video');
  if (videos.length > 0) {
    lines.push(`- Videos: ${videos.map(a => a.filename).join(', ')}`);
  }

  const files = msg.attachments.filter(a => a.content_type === 'file');
  if (files.length > 0) {
    lines.push(`- Files: ${files.map(a => `${a.filename} (${formatFileSize(a.size)})`).join(', ')}`);
  }

  if (lines.length === 0) return '';

  const quoteAttachments = state.quote?.attachments;
  if (quoteAttachments && quoteAttachments.length > 0) {
    lines.push('[Reference attachments]');
    for (const qa of quoteAttachments) {
      const label = qa.asrText ? `Voice: ${qa.asrText}` : (qa.filename ?? qa.contentType ?? 'attachment');
      lines.push(`  - ${label}`);
    }
  }

  return lines.join('\n') + '\n\n';
}

/**
 * Layer 5: 最终 agentBody 拼合
 */
function buildAgentBody(
  base: string,
  history: HistoryEntry[] | undefined,
  isGroup: boolean,
  wasMentioned: boolean,
): string {
  if (!isGroup || !wasMentioned || !history || history.length === 0) {
    return base;
  }

  const historyLines = history.map(h => {
    const name = h.senderName ?? h.senderId.slice(0, 8);
    return `[${name} (${h.senderId})] ${h.content}`;
  });

  return [
    '[Chat history begins]',
    ...historyLines,
    '',
    '[Chat history ends]',
    '[Current message]',
    base,
  ].join('\n');
}

// ══════════════════════════════════════════════════════════════
// 辅助函数
// ══════════════════════════════════════════════════════════════

interface VoiceText {
  text: string;
  duration?: number;
  source: 'stt' | 'asr' | 'fallback';
}

function extractVoiceTexts(
  attachments?: Attachment[],
  processed?: ProcessedAttachment[],
  _logger?: Logger,
): VoiceText[] {
  const results: VoiceText[] = [];

  if (processed) {
    for (const pa of processed) {
      if (pa.type === 'voice' && pa.voiceText) {
        results.push({
          text: pa.voiceText,
          duration: pa.duration,
          source: pa.voiceSource ?? 'stt',
        });
      }
    }
  }

  if (results.length === 0 && attachments) {
    for (const att of attachments) {
      if (att.content_type === 'voice' && att.asr_refer_text) {
        results.push({
          text: att.asr_refer_text.trim(),
          source: 'asr',
        });
      }
    }
  }

  return results;
}

function describeAttachments(
  attachments?: Attachment[],
  _processed?: ProcessedAttachment[],
): string {
  if (!attachments || attachments.length === 0) return '';

  const parts: string[] = [];

  for (const att of attachments) {
    switch (att.content_type) {
      case 'voice':
        break;
      case 'image': {
        const dim = att.width && att.height ? ` ${att.width}×${att.height}` : '';
        parts.push(`[Image: ${att.filename}${dim}]`);
        break;
      }
      case 'video':
        parts.push(`[Video: ${att.filename}]`);
        break;
      case 'file':
        parts.push(`[File: ${att.filename} (${formatFileSize(att.size)})]`);
        break;
      default:
        parts.push(`[Attachment: ${att.filename ?? att.content_type}]`);
        break;
    }
  }

  return parts.join('\n');
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
