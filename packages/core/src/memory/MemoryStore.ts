import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * MemoryStore — WorkerKing's durable, auditable memory.
 *
 * A file-based store (JSON source of truth + a Markdown mirror the user can read
 * or hand-edit). Deliberately not a database: memories should be portable and
 * inspectable, matching the "auditable, hand-editable" goal. Uses Mem0-style
 * update-not-append semantics so facts stay current instead of piling up.
 *
 * The store summary is injected into the persona so memories are always in
 * context (the CLAUDE.md pattern, WorkerKing-managed), and a `remember` tool lets
 * Claude write new facts mid-task.
 */

export type MemoryScope = 'preference' | 'fact' | 'project';

export interface MemoryEntry {
  key: string;
  value: string;
  scope: MemoryScope;
  ts: number;
  /** Where it came from, e.g. 'remember-tool', 'nightly-consolidation'. */
  provenance: string;
  /** Set when consolidation judges it outdated; kept for audit, hidden from summary. */
  stale?: boolean;
}

export interface MemoryStoreOptions {
  /** Directory for the store files. Defaults to ~/.claude/workerking. */
  dir?: string;
  now?: () => number;
}

export class MemoryStore {
  private readonly dir: string;
  private readonly jsonPath: string;
  private readonly mdPath: string;
  private readonly now: () => number;
  private entries: MemoryEntry[] = [];

  constructor(opts: MemoryStoreOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.claude', 'workerking');
    this.jsonPath = join(this.dir, 'memories.json');
    this.mdPath = join(this.dir, 'memories.md');
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  private load(): void {
    if (existsSync(this.jsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(this.jsonPath, 'utf8'));
        if (Array.isArray(parsed?.entries)) this.entries = parsed.entries;
      } catch {
        // Corrupt file → start fresh but don't clobber until the next write.
      }
    }
  }

  private persist(): void {
    mkdirSync(this.dir, { recursive: true });
    // Atomic (tmp + rename): a crash mid-write must not truncate the store.
    const tmpJson = `${this.jsonPath}.${process.pid}.tmp`;
    writeFileSync(tmpJson, JSON.stringify({ entries: this.entries }, null, 2), 'utf8');
    renameSync(tmpJson, this.jsonPath);
    const tmpMd = `${this.mdPath}.${process.pid}.tmp`;
    writeFileSync(tmpMd, this.toMarkdown(), 'utf8');
    renameSync(tmpMd, this.mdPath);
  }

  /** Store or update a memory (update-not-append: same key overwrites). */
  remember(
    key: string,
    value: string,
    scope: MemoryScope = 'fact',
    provenance = 'remember-tool',
  ): void {
    const existing = this.entries.find((e) => e.key === key);
    if (existing) {
      existing.value = value;
      existing.scope = scope;
      existing.ts = this.now();
      existing.provenance = provenance;
      existing.stale = false;
    } else {
      this.entries.push({ key, value, scope, ts: this.now(), provenance });
    }
    this.persist();
  }

  /** Mark an entry stale (kept for audit, excluded from the summary). */
  markStale(key: string): void {
    const e = this.entries.find((x) => x.key === key);
    if (e) {
      e.stale = true;
      this.persist();
    }
  }

  /** Simple substring recall over key+value (non-stale first). */
  recall(query?: string): MemoryEntry[] {
    const live = this.entries.filter((e) => !e.stale);
    if (!query) return live;
    const q = query.toLowerCase();
    return live.filter((e) => e.key.toLowerCase().includes(q) || e.value.toLowerCase().includes(q));
  }

  all(): MemoryEntry[] {
    return [...this.entries];
  }

  /** Replace the entire set (used by consolidation). */
  replaceAll(entries: MemoryEntry[]): void {
    this.entries = entries;
    this.persist();
  }

  /** Budget-capped summary for persona injection. */
  summary(maxChars = 1200): string {
    const live = this.entries.filter((e) => !e.stale);
    if (!live.length) return '';
    const lines = live
      .sort((a, b) => b.ts - a.ts)
      .map((e) => `- (${e.scope}) ${e.key}: ${e.value}`);
    let out = 'What you remember about the user:\n';
    for (const line of lines) {
      if (out.length + line.length + 1 > maxChars) {
        out += '- …(more in memory; ask to list all)';
        break;
      }
      out += line + '\n';
    }
    return out.trim();
  }

  private toMarkdown(): string {
    const live = this.entries.filter((e) => !e.stale);
    const stale = this.entries.filter((e) => e.stale);
    const fmt = (e: MemoryEntry) =>
      `- **${e.key}** (${e.scope}): ${e.value}  \n  _${new Date(e.ts).toISOString()} · ${e.provenance}_`;
    let md =
      '# WorkerKing memory\n\n> Auto-managed by WorkerKing. You can hand-edit `memories.json`.\n\n';
    md += live.length ? live.map(fmt).join('\n') + '\n' : '_No memories yet._\n';
    if (stale.length) md += '\n## Stale (kept for audit)\n' + stale.map(fmt).join('\n') + '\n';
    return md;
  }
}
