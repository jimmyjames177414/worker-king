import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

/**
 * VaultContext — points the daemon brain at the user's global knowledge vault
 * (a claude-obsidian / "context2"-style Obsidian wiki maintained by Claude).
 *
 * The vault's own design gives us two cheap, high-value excerpts:
 *   - `wiki/hot.md`   — the hot cache: recent-session context, written to be
 *                       loaded at session start.
 *   - `wiki/index.md` — the structure/table of contents.
 * Both are folded (capped + fenced as untrusted data) into the ambient context;
 * the usage rules tell the model to read/cite/file vault pages with its normal
 * file tools, following the vault's own conventions.
 *
 * Reads are async + cached; the prompt path (`vaultBlock()`) is synchronous and
 * never blocks — an unreachable vault (WSL down) degrades to a note.
 */

export interface VaultFs {
  readFile(path: string): Promise<string>;
}

const realFs: VaultFs = {
  readFile: (path) => fsp.readFile(path, 'utf8'),
};

export interface VaultContextOptions {
  fs?: VaultFs;
  now?: () => number;
  cacheTtlMs?: number;
  hotCapChars?: number;
  indexCapChars?: number;
  /**
   * Wrap vault-derived text as untrusted data (the vault is written by past
   * sessions and tools — treat it like any externally influenced content).
   */
  fence?: (label: string, text: string) => string;
}

interface VaultCache {
  at: number;
  path: string;
  hot?: string;
  index?: string;
  error?: string;
}

export class VaultContext {
  private readonly fs: VaultFs;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly hotCapChars: number;
  private readonly indexCapChars: number;
  private readonly fence: (label: string, text: string) => string;
  private cache?: VaultCache;
  private refreshing = false;

  constructor(
    private readonly getVaultPath: () => string | undefined,
    opts: VaultContextOptions = {},
  ) {
    this.fs = opts.fs ?? realFs;
    this.now = opts.now ?? Date.now;
    this.cacheTtlMs = opts.cacheTtlMs ?? 60_000;
    this.hotCapChars = opts.hotCapChars ?? 2000;
    this.indexCapChars = opts.indexCapChars ?? 1500;
    this.fence = opts.fence ?? ((_label, text) => text);
  }

  /** Read hot.md + index.md now (startup / tests). */
  async refresh(): Promise<void> {
    const path = this.getVaultPath();
    if (!path || this.refreshing) return;
    this.refreshing = true;
    try {
      const [hot, index] = await Promise.all([
        this.fs.readFile(join(path, 'wiki', 'hot.md')).catch(() => undefined),
        this.fs.readFile(join(path, 'wiki', 'index.md')).catch(() => undefined),
      ]);
      if (hot === undefined && index === undefined) {
        this.cache = { at: this.now(), path, error: 'unreachable' };
      } else {
        this.cache = {
          at: this.now(),
          path,
          hot: hot?.slice(0, this.hotCapChars),
          index: index?.slice(0, this.indexCapChars),
        };
      }
    } finally {
      this.refreshing = false;
    }
  }

  /**
   * The vault block folded into the ambient context. Synchronous: reads only
   * the cache and schedules a background refresh when stale.
   */
  vaultBlock(): string {
    const path = this.getVaultPath();
    if (!path) return '';
    if (!this.cache || this.cache.path !== path || this.now() - this.cache.at > this.cacheTtlMs) {
      void this.refresh();
    }
    const lines: string[] = [`Global knowledge vault: ${path}`];
    if (!this.cache || this.cache.path !== path) {
      lines.push('(vault contents still loading)');
    } else if (this.cache.error) {
      lines.push('(vault unreachable right now — answer without it)');
    } else {
      if (this.cache.index) {
        lines.push('Vault index (wiki/index.md, excerpt):');
        lines.push(this.fence('vault-index', this.cache.index));
      }
      if (this.cache.hot) {
        lines.push('Vault hot cache (wiki/hot.md, recent context, excerpt):');
        lines.push(this.fence('vault-hot-cache', this.cache.hot));
      }
    }
    lines.push(
      'Vault usage: for knowledge/recall questions, consult the vault first — read the relevant ' +
        'pages under wiki/ and cite them. When you learn something durable, file it into the ' +
        "vault following the vault's own CLAUDE.md conventions (respect .vault-meta/locks). " +
        'Prefer updating existing pages over creating duplicates.',
    );
    return lines.join('\n');
  }
}
