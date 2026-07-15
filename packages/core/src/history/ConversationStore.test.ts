import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationStore } from './ConversationStore.js';

let clock = 0;
const now = () => (clock += 1000);
let n = 0;
const newId = () => `c${++n}`;

function store(dir?: string) {
  clock = 0;
  n = 0;
  return new ConversationStore({ dir: dir ?? mkdtempSync(join(tmpdir(), 'wk-conv-')), now, newId });
}

describe('ConversationStore', () => {
  it('appends turns to the current conversation and titles from the first user line', () => {
    const s = store();
    s.append('user', 'How do I rename files?');
    s.append('assistant', 'Use a loop.');
    const list = s.list();
    expect(list).toHaveLength(1);
    expect(list[0].title).toBe('How do I rename files?');
    expect(list[0].messageCount).toBe(2);
  });

  it('starts new conversations and keeps them separate', () => {
    const s = store();
    s.append('user', 'first');
    const firstId = s.currentId();
    const secondId = s.startNew();
    s.append('user', 'second');
    expect(secondId).not.toBe(firstId);
    expect(s.load(firstId)?.map((m) => m.text)).toEqual(['first']);
    expect(s.load(secondId)?.map((m) => m.text)).toEqual(['second']);
  });

  it('resumes a conversation with setCurrent so new turns append there', () => {
    const s = store();
    s.append('user', 'alpha');
    const first = s.currentId();
    s.startNew();
    s.append('user', 'beta');
    expect(s.setCurrent(first)).toBe(true);
    s.append('assistant', 'more alpha');
    expect(s.load(first)?.map((m) => m.text)).toEqual(['alpha', 'more alpha']);
    expect(s.setCurrent('nope')).toBe(false);
  });

  it('persists across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
    const a = store(dir);
    a.append('user', 'remember me');
    const id = a.currentId();
    const b = new ConversationStore({ dir, now, newId });
    expect(b.load(id)?.[0]?.text).toBe('remember me');
  });

  it('lists most-recently-updated first', () => {
    const s = store();
    s.append('user', 'old');
    const oldId = s.currentId();
    s.startNew();
    s.append('user', 'new');
    const newId2 = s.currentId();
    expect(s.list().map((c) => c.id)).toEqual([newId2, oldId]);
  });

  it('deletes a conversation', () => {
    const s = store();
    s.append('user', 'doomed');
    const id = s.currentId();
    expect(s.delete(id)).toBe(true);
    expect(s.list()).toHaveLength(0);
    expect(s.delete('nope')).toBe(false);
  });

  it('prunes empty abandoned conversations', () => {
    const s = store();
    s.append('user', 'real');
    s.startNew(); // empty
    s.startNew(); // empty, becomes current
    // Only the non-empty one plus the current empty survive a prune (via startNew).
    const summaries = s.list();
    expect(summaries.filter((c) => c.messageCount > 0)).toHaveLength(1);
  });

  it('caps retained conversations', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
    const s = new ConversationStore({ dir, now, newId, maxConversations: 2 });
    for (let i = 0; i < 5; i++) {
      s.startNew();
      s.append('user', `msg ${i}`);
    }
    expect(s.list().length).toBeLessThanOrEqual(2);
  });

  it('folds truncated messages into a rolling summary instead of losing them (N14)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
    const s = new ConversationStore({ dir, now, newId, maxMessagesPerConversation: 2 });
    s.append('user', 'first question');
    s.append('assistant', 'first answer');
    s.append('user', 'second question'); // evicts "first question"
    const id = s.currentId();
    expect(s.load(id)?.map((m) => m.text)).toEqual(['first answer', 'second question']);
    const summary = s.getSummary(id);
    expect(summary).toBeDefined();
    expect(summary).toContain('user: first question');
  });

  it('accumulates the summary across multiple truncations and stays bounded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
    const s = new ConversationStore({ dir, now, newId, maxMessagesPerConversation: 1 });
    for (let i = 0; i < 5; i++) s.append('user', `turn ${i}`);
    const summary = s.getSummary(s.currentId())!;
    expect(summary).toContain('turn 0');
    expect(summary).toContain('turn 3'); // earlier turns preserved in the roll-up
    expect(summary.length).toBeLessThanOrEqual(1201);
  });

  it('uses an injected summarizer when provided', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wk-conv-'));
    const s = new ConversationStore({
      dir,
      now,
      newId,
      maxMessagesPerConversation: 1,
      summarize: ({ dropped, previous }) => `${previous ?? ''}[${dropped.length}]`,
    });
    s.append('user', 'a');
    s.append('user', 'b'); // drops 'a'
    s.append('user', 'c'); // drops 'b'
    expect(s.getSummary(s.currentId())).toBe('[1][1]');
  });
});
