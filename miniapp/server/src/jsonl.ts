/**
 * Full session history, read from messages.jsonl on disk.
 *
 * Why not the facade: `aside.sessions.messages(id)` returns the agent's
 * CURRENT CONTEXT, not the conversation. On a long or compacted session it
 * starts mid-conversation -- verified on a long live session, where the
 * facade hands back 50 messages beginning with a `system-message` while the
 * transcript on disk holds 300 lines and four separate user turns. Built
 * from the facade, that session collapses into one bare work fold with no
 * user bubble and no answers.
 *
 * The jsonl carries the same record shape the facade emits (`role`,
 * `content`, `timestamp`, `toolCallId`, `toolName`, `details`, `isError`),
 * so the thread builder consumes either. The differences this module
 * normalises away:
 *
 *  - Timestamps are seconds on disk and ms in places; both are coerced to ms.
 *  - `content` is a bare STRING on user messages written by the CLI, and a
 *    part array on assistant messages.
 *  - `user-message-metadata` is a separate record that PRECEDES the user
 *    message it belongs to and carries that message's attachments. It is
 *    folded onto the following user message rather than surfaced as a row.
 *  - `system-message` is skipped, exactly as the browser skips it.
 */
import fs from 'node:fs';
import type { FacadeMessage } from './facade.js';

/** A file the user attached to a message, as the transcript records it. */
export interface MessageAttachment {
  name: string;
  mimeType?: string;
}

export interface HistoryMessage extends FacadeMessage {
  /** Present on user messages that carried attachments. */
  attachments?: MessageAttachment[];
  /** Assistant token accounting: `totalTokens`, `output`, `reasoning`, … */
  usage?: Record<string, unknown>;
  /**
   * Why the assistant stopped. `"error"` is the one value that matters
   * here: it marks a turn the provider refused or dropped.
   */
  stopReason?: string;
  /**
   * The provider's own failure message, present on `stopReason: "error"`
   * records.
   *
   * This is where a rate limit, an expired sign-in or a timeout actually
   * lives -- verified against real transcripts, e.g. `{"role":"assistant",
   * "stopReason":"error","errorMessage":"429 status code (no body)",
   * "content":[]}`. Note the empty `content`: nothing else on the record
   * says anything went wrong, so a builder that only reads `content`
   * renders the turn as a blank response. That is exactly the bug this
   * field exists to fix.
   */
  errorMessage?: string;
}

/** Aside writes timestamps in seconds on some records and ms on others. */
export function normalizeTimestamp(raw: unknown): number | undefined {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n > 1e12 ? n : Math.round(n * 1000);
}

function readAttachments(raw: unknown): MessageAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: MessageAttachment[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const name = String((item as any).name || '').trim();
    if (!name) continue;
    out.push({
      name,
      mimeType: (item as any).mimeType
        ? String((item as any).mimeType)
        : undefined,
    });
  }
  return out;
}

/**
 * Parse a whole transcript buffer into the message list the thread builder
 * consumes. Corrupt lines are skipped, as they are everywhere else here.
 */
export function parseHistory(buffer: string): HistoryMessage[] {
  const out: HistoryMessage[] = [];
  // Attachments arrive on their own record just BEFORE the user message
  // they describe, so they are held until that message shows up.
  let pendingAttachments: MessageAttachment[] = [];

  for (const raw of String(buffer || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const role = String(msg.role || '');
    if (!role) continue;

    if (role === 'user-message-metadata') {
      const found = readAttachments(msg.attachments);
      if (found.length) pendingAttachments = found;
      continue;
    }

    // The browser hides system messages; so do we. They are injected
    // context (skill hints, and similar), not conversation.
    if (role === 'system-message') continue;

    const entry: HistoryMessage = {
      role,
      content: msg.content,
      timestamp: normalizeTimestamp(msg.timestamp),
    };
    if (typeof msg.model === 'string') entry.model = msg.model;
    if (typeof msg.provider === 'string') entry.provider = msg.provider;
    if (typeof msg.toolCallId === 'string') entry.toolCallId = msg.toolCallId;
    if (typeof msg.toolName === 'string') entry.toolName = msg.toolName;
    if (msg.details && typeof msg.details === 'object') {
      entry.details = msg.details as Record<string, unknown>;
    }
    if (msg.usage && typeof msg.usage === 'object') {
      entry.usage = msg.usage as Record<string, unknown>;
    }
    if (typeof msg.stopReason === 'string') entry.stopReason = msg.stopReason;
    if (typeof msg.errorMessage === 'string') {
      entry.errorMessage = msg.errorMessage;
    }
    if (msg.isError) entry.isError = true;

    if (role === 'user' && pendingAttachments.length) {
      entry.attachments = pendingAttachments;
      pendingAttachments = [];
    }

    out.push(entry);
  }

  return out;
}

/**
 * Largest transcript this will pull into memory at once.
 *
 * The `/messages` route already refused anything past this; the thread
 * path did not, and the thread path is the hot one -- it runs on every
 * thread request AND on every WebSocket push, with up to 16 results held
 * in the thread cache. A 50MB transcript becomes a 50MB string and then
 * several hundred MB of parsed objects, so a handful of long sessions
 * could take the process out on a machine that had been up for weeks.
 *
 * Matches MAX_TRANSCRIPT_BYTES in app.ts.
 */
export const MAX_HISTORY_BYTES = 32 * 1024 * 1024;

/**
 * True when a transcript is past the cap and cannot be rendered.
 *
 * `readHistory` has to fail SAFE -- returning `[]` rather than allocating
 * half a gigabyte -- but an empty array is indistinguishable from "this
 * chat has no messages", and that is what the thread route was serving: a
 * blank conversation, 200 OK, no explanation, for a session full of work.
 * Callers that can say something better ask this first and answer 413
 * `transcript_too_large`, which the client already has copy for.
 */
export function transcriptTooLarge(
  msgFile: string,
  maxBytes = MAX_HISTORY_BYTES,
): boolean {
  const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
  return Boolean(stat?.isFile() && stat.size > maxBytes);
}

/** Read and parse a session transcript. Missing/unreadable reads as empty. */
export function readHistory(
  msgFile: string,
  maxBytes = MAX_HISTORY_BYTES,
): HistoryMessage[] {
  let buffer = '';
  try {
    // Stat before read: the point is to never allocate the string at all.
    const stat = fs.statSync(msgFile, { throwIfNoEntry: false });
    if (!stat?.isFile()) return [];
    if (stat.size > maxBytes) return [];
    buffer = fs.readFileSync(msgFile, 'utf8');
  } catch {
    return [];
  }
  return parseHistory(buffer);
}
