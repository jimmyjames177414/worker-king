import { mkdirSync, appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * InteractionLog — an append-only record of what happened, per day, as JSONL.
 *
 * Feeds the nightly consolidation job (the raw material it distills into durable
 * memories). Kept separate from MemoryStore: this is the firehose, memory is the
 * curated result.
 */
export interface InteractionEntry {
  ts: number;
  kind: 'chat' | 'task';
  /** Short human-readable summary of the exchange. */
  text: string;
}

export interface InteractionLogOptions {
  dir?: string;
  now?: () => number;
  /** Injected for deterministic filenames in tests. */
  today?: () => string;
}

export class InteractionLog {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly today: () => string;

  constructor(opts: InteractionLogOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.claude', 'workerking', 'interactions');
    this.now = opts.now ?? (() => Date.now());
    // Default day key derived from the injected clock (no bare new Date()).
    this.today = opts.today ?? (() => new Date(this.now()).toISOString().slice(0, 10));
  }

  append(kind: InteractionEntry['kind'], text: string): void {
    mkdirSync(this.dir, { recursive: true });
    const entry: InteractionEntry = { ts: this.now(), kind, text };
    appendFileSync(join(this.dir, `${this.today()}.jsonl`), JSON.stringify(entry) + '\n', 'utf8');
  }

  /** Read the most recent `limit` entries across all day files. */
  readRecent(limit = 200): InteractionEntry[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort(); // ISO date names sort chronologically
    const entries: InteractionEntry[] = [];
    for (const f of files) {
      for (const line of readFileSync(join(this.dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // skip malformed line
        }
      }
    }
    return entries.slice(-limit);
  }
}
