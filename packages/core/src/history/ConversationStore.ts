import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ConversationMessage, ConversationSummary } from '@workerking/shared';
import { writeJsonAtomic } from '../util/atomicJson.js';

/**
 * ConversationStore — durable, browsable chat history.
 *
 * The renderer's localStorage keeps the *live* transcript; this is the daemon's
 * authoritative record so past conversations survive an app reinstall and can be
 * listed/reopened. File-backed (single JSON under ~/.claude/workerking), matching
 * MemoryStore — inspectable and portable, not a database. One conversation is
 * "current"; chat turns append to it until a new one is started or another is
 * loaded (resumed). Bounded so the file can't grow without limit.
 */

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ConversationMessage[];
  /**
   * Rolling gist of messages that fell out of the retained window (N14) — so
   * truncation doesn't silently lose the earlier context from the durable record.
   */
  summary?: string;
  /** SDK session id, so a resumed conversation can reattach its Claude session. */
  sdkSessionId?: string;
}

/** Summarizes messages evicted by truncation into the rolling conversation summary. */
export type ConversationSummarizer = (args: {
  dropped: ConversationMessage[];
  previous?: string;
}) => string;

export interface ConversationStoreOptions {
  dir?: string;
  now?: () => number;
  newId?: () => string;
  /** Cap on retained conversations (oldest pruned). Default 100. */
  maxConversations?: number;
  /** Cap on messages kept per conversation. Default 500. */
  maxMessagesPerConversation?: number;
  /** How dropped messages are folded into the rolling summary (default: compact roll-up). */
  summarize?: ConversationSummarizer;
}

/** Deterministic default: a bounded, readable roll-up of the dropped turns. */
export function defaultConversationSummarizer({
  dropped,
  previous,
}: {
  dropped: ConversationMessage[];
  previous?: string;
}): string {
  const parts = dropped.map(
    (m) => `${m.role}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`,
  );
  const combined = [previous, ...parts].filter(Boolean).join(' | ');
  // Keep the rolling summary bounded so it can't grow without limit either.
  const MAX = 1200;
  return combined.length > MAX ? `…${combined.slice(combined.length - MAX)}` : combined;
}

interface Persisted {
  conversations: Conversation[];
  currentId?: string;
}

const TITLE_MAX = 60;

export class ConversationStore {
  private readonly path: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly maxConversations: number;
  private readonly maxMessages: number;
  private readonly summarize: ConversationSummarizer;
  private data: Persisted = { conversations: [] };

  constructor(opts: ConversationStoreOptions = {}) {
    const dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.path = join(dir, 'conversations.json');
    this.now = opts.now ?? (() => Date.now());
    // Random suffix: two conversations created within one ms must not collide
    // (a length-based suffix reuses ids after a delete, mis-targeting setCurrent).
    this.newId =
      opts.newId ??
      (() => `conv-${Math.floor(this.now())}-${Math.random().toString(36).slice(2, 8)}`);
    this.maxConversations = Math.max(1, opts.maxConversations ?? 100);
    this.maxMessages = Math.max(1, opts.maxMessagesPerConversation ?? 500);
    this.summarize = opts.summarize ?? defaultConversationSummarizer;
    this.hydrate();
  }

  private hydrate(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'));
      if (Array.isArray(parsed?.conversations)) {
        // Keep only structurally sound conversations; a hand-edited entry must
        // not crash list()/append() later. currentId is only honored if it
        // points at a surviving conversation.
        const conversations = (parsed.conversations as Conversation[]).filter(
          (c) =>
            !!c &&
            typeof c === 'object' &&
            typeof c.id === 'string' &&
            typeof c.title === 'string' &&
            Array.isArray(c.messages),
        );
        const currentId =
          typeof parsed.currentId === 'string' && conversations.some((c) => c.id === parsed.currentId)
            ? (parsed.currentId as string)
            : undefined;
        this.data = { conversations, currentId };
      }
    } catch {
      // Corrupt file → start fresh; the next write repairs it.
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.path, this.data);
    } catch {
      // Best-effort; history must never crash the daemon.
    }
  }

  private find(id: string): Conversation | undefined {
    return this.data.conversations.find((c) => c.id === id);
  }

  /** The active conversation, creating one if none exists. */
  private current(): Conversation {
    const existing = this.data.currentId ? this.find(this.data.currentId) : undefined;
    if (existing) return existing;
    const id = this.startNew();
    return this.find(id)!;
  }

  /** Begin a fresh conversation and make it current; returns its id. */
  startNew(): string {
    const t = this.now();
    const conv: Conversation = { id: this.newId(), title: 'New chat', createdAt: t, updatedAt: t, messages: [] };
    this.data.conversations.push(conv);
    this.data.currentId = conv.id;
    this.prune();
    this.persist();
    return conv.id;
  }

  /**
   * Append a turn to the current conversation. Titles from the first user line.
   * Returns the conversation's id so a caller can thread a later reply to the
   * same conversation (see appendTo) even if "current" changes meanwhile.
   */
  append(role: ConversationMessage['role'], text: string): string {
    return this.appendToConversation(this.current(), role, text);
  }

  /**
   * Append to a *specific* conversation — the streaming-reply case: the user
   * turn went to conversation X, then the user hit "new chat"/loaded another
   * while the brain was still responding. The assistant turn must land in X,
   * not whichever conversation is current at completion time. Falls back to
   * the current conversation if `id` was deleted meanwhile.
   */
  appendTo(id: string, role: ConversationMessage['role'], text: string): string {
    return this.appendToConversation(this.find(id) ?? this.current(), role, text);
  }

  private appendToConversation(
    conv: Conversation,
    role: ConversationMessage['role'],
    text: string,
  ): string {
    conv.messages.push({ role, text, ts: this.now() });
    if (conv.messages.length > this.maxMessages) {
      // Fold the evicted turns into the rolling summary before dropping them,
      // so the durable record doesn't silently forget earlier context (N14).
      const dropped = conv.messages.splice(0, conv.messages.length - this.maxMessages);
      conv.summary = this.summarize({ dropped, previous: conv.summary });
    }
    if (conv.title === 'New chat' && role === 'user') {
      conv.title = text.slice(0, TITLE_MAX) + (text.length > TITLE_MAX ? '…' : '');
    }
    conv.updatedAt = this.now();
    this.persist();
    return conv.id;
  }

  /** Attach the SDK session id to the current conversation (for later resume). */
  setSessionId(sdkSessionId: string): void {
    const conv = this.current();
    conv.sdkSessionId = sdkSessionId;
    this.persist();
  }

  currentId(): string {
    return this.current().id;
  }

  /** Make an existing conversation current (resume). Returns false if unknown. */
  setCurrent(id: string): boolean {
    if (!this.find(id)) return false;
    this.data.currentId = id;
    this.persist();
    return true;
  }

  /** Metadata for every conversation, most recently updated first. */
  list(): ConversationSummary[] {
    return this.data.conversations
      .map((c) => ({
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c.messages.length,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Full messages for one conversation. */
  load(id: string): ConversationMessage[] | undefined {
    return this.find(id)?.messages;
  }

  /** Rolling summary of context that was truncated out of a conversation, if any. */
  getSummary(id: string): string | undefined {
    return this.find(id)?.summary;
  }

  /**
   * Summary of the *current* conversation without creating one — safe to call
   * while assembling per-message context (unlike currentId(), which would start
   * a conversation as a side effect).
   */
  currentSummary(): string | undefined {
    const conv = this.data.currentId ? this.find(this.data.currentId) : undefined;
    return conv?.summary;
  }

  /** Delete a conversation; if it was current, the next append starts a new one. */
  delete(id: string): boolean {
    const i = this.data.conversations.findIndex((c) => c.id === id);
    if (i < 0) return false;
    this.data.conversations.splice(i, 1);
    if (this.data.currentId === id) this.data.currentId = undefined;
    this.persist();
    return true;
  }

  /** Drop empty stale conversations and enforce the retention cap (oldest first). */
  private prune(): void {
    // Remove empty conversations that aren't current (abandoned "New chat"s).
    this.data.conversations = this.data.conversations.filter(
      (c) => c.messages.length > 0 || c.id === this.data.currentId,
    );
    if (this.data.conversations.length > this.maxConversations) {
      this.data.conversations.sort((a, b) => a.updatedAt - b.updatedAt);
      this.data.conversations.splice(0, this.data.conversations.length - this.maxConversations);
    }
  }
}
