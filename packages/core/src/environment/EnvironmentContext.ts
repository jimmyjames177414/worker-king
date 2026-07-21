import { promises as fsp } from 'node:fs';
import { join, win32 as pathWin32, posix as pathPosix } from 'node:path';

/**
 * EnvironmentContext — the daemon brain's OS-level orientation (the "main
 * brain" layer): which directories hold the user's repos (Windows and WSL
 * roots), what actually lives there, and how to resolve "open X" / "do this in
 * folder Y". The block it builds is injected into the ambient context every
 * message (chat AND delegated tasks, via the shared personaProvider seam), and
 * `resolveRepoPath` backs the delegate_to_worker `folder` argument.
 *
 * Scanning is async + cached; the prompt path (`environmentBlock()`) is fully
 * synchronous and never blocks on the filesystem — an unreachable root (WSL
 * down, drive unplugged) degrades to a note instead of hanging a chat turn.
 */

export interface EnvFs {
  /** Names of the immediate subdirectories of `root`. */
  listDirs(root: string): Promise<string[]>;
  isDir(path: string): Promise<boolean>;
}

const realFs: EnvFs = {
  async listDirs(root) {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  },
  async isDir(path) {
    try {
      return (await fsp.stat(path)).isDirectory();
    } catch {
      return false;
    }
  },
};

/** Live view of the env-relevant config keys (read per call, like liveCwd). */
export interface EnvironmentConfigView {
  repoRoots?: string[];
  envNotes?: string;
  claudeHost?: string;
}

export interface EnvironmentContextOptions {
  fs?: EnvFs;
  now?: () => number;
  /** How long a root's listing stays fresh. */
  cacheTtlMs?: number;
  /** Cap on repo names listed per root in the prompt block. */
  maxReposPerRoot?: number;
  platform?: string;
}

export type ResolvedRepoPath = { ok: true; path: string } | { ok: false; error: string };

interface RootCache {
  at: number;
  repos?: string[];
  error?: string;
}

export class EnvironmentContext {
  private readonly fs: EnvFs;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxReposPerRoot: number;
  private readonly platform: string;
  private readonly cache = new Map<string, RootCache>();
  private readonly refreshing = new Set<string>();

  constructor(
    private readonly getConfig: () => EnvironmentConfigView,
    opts: EnvironmentContextOptions = {},
  ) {
    this.fs = opts.fs ?? realFs;
    this.now = opts.now ?? Date.now;
    this.cacheTtlMs = opts.cacheTtlMs ?? 5 * 60_000;
    this.maxReposPerRoot = opts.maxReposPerRoot ?? 40;
    this.platform = opts.platform ?? process.platform;
  }

  /** Refresh every configured root's listing now (startup / tests). */
  async refresh(): Promise<void> {
    const roots = this.getConfig().repoRoots ?? [];
    await Promise.all(roots.map((r) => this.refreshRoot(r)));
  }

  private async refreshRoot(root: string): Promise<void> {
    if (this.refreshing.has(root)) return;
    this.refreshing.add(root);
    try {
      const repos = await this.fs.listDirs(root);
      this.cache.set(root, { at: this.now(), repos });
    } catch (err) {
      this.cache.set(root, { at: this.now(), error: String(err) });
    } finally {
      this.refreshing.delete(root);
    }
  }

  /** Cached listing for `root`, scheduling a background refresh when stale. */
  private cached(root: string): RootCache | undefined {
    const entry = this.cache.get(root);
    if (!entry || this.now() - entry.at > this.cacheTtlMs) {
      // Never block the prompt path on the filesystem — refresh in background.
      void this.refreshRoot(root);
    }
    return entry;
  }

  /**
   * The environment block folded into the ambient context. Synchronous: reads
   * only the cache (first message after boot may show roots as still scanning).
   */
  environmentBlock(): string {
    const cfg = this.getConfig();
    const roots = cfg.repoRoots ?? [];
    if (roots.length === 0 && !cfg.envNotes) return '';
    const lines: string[] = ['Environment:'];
    lines.push(`- OS: ${this.platform}${cfg.claudeHost ? ` (claudeHost: ${cfg.claudeHost})` : ''}`);
    if (roots.length) {
      lines.push('- Known repo roots (each subfolder is a repo/project):');
      for (const root of roots) {
        const entry = this.cached(root);
        if (!entry) {
          lines.push(`  - ${root} (scanning…)`);
        } else if (entry.error) {
          lines.push(`  - ${root} (unreachable right now)`);
        } else {
          const repos = entry.repos ?? [];
          const shown = repos.slice(0, this.maxReposPerRoot);
          const more = repos.length - shown.length;
          lines.push(
            `  - ${root}: ${shown.join(', ') || '(empty)'}${more > 0 ? ` (+${more} more)` : ''}`,
          );
        }
      }
      lines.push(
        '- When asked to open or work in a repo/folder by name, resolve it against these roots ' +
          '(exact then prefix match). Open folders/apps on Windows with `explorer.exe <path>` or ' +
          '`start`; WSL paths are reachable from Windows via their \\\\wsl.localhost UNC form. ' +
          'For substantive work in another repo, delegate a task with its `folder`.',
      );
    }
    if (cfg.envNotes) lines.push(`- Notes: ${cfg.envNotes}`);
    return lines.join('\n');
  }

  /**
   * Compact, flat repo listing for the thin voice model — every repo name across
   * all roots, so "work on X" resolves without a delegation round-trip. Names
   * only (no roots/rules paragraph). Synchronous like `environmentBlock()`: reads
   * the cache and background-refreshes on staleness. The overall voice prompt is
   * char-capped downstream, so this returns the full set.
   */
  voiceOrientation(): string {
    const roots = this.getConfig().repoRoots ?? [];
    if (!roots.length) return '';
    const seen = new Set<string>();
    const names: string[] = [];
    for (const root of roots) {
      for (const name of this.cached(root)?.repos ?? []) {
        const key = name.toLowerCase();
        if (seen.has(key)) continue; // a repo mirrored under two roots shows once
        seen.add(key);
        names.push(name);
      }
    }
    if (!names.length) return '';
    return `Available projects (say "work on <name>"): ${names.join(', ')}.`;
  }

  /**
   * Resolve a repo name or path for a delegated task's working directory.
   * Absolute existing paths pass through; bare names match top-level dirs across
   * the configured roots — exact (case-insensitive) first, then unique prefix.
   */
  async resolveRepoPath(nameOrPath: string): Promise<ResolvedRepoPath> {
    const input = nameOrPath.trim();
    if (!input) return { ok: false, error: 'No folder given.' };

    // Detect absolute paths with the semantics of the *target* platform, not the
    // daemon's: a WSL/Linux daemon still manages Windows repos, and a `C:\…` path
    // is absolute there even though POSIX isAbsolute would reject it (and vice
    // versa). Bare-name resolution below keeps using node:path's join.
    const isAbsolute =
      this.platform === 'win32' ? pathWin32.isAbsolute(input) : pathPosix.isAbsolute(input);
    if (isAbsolute || input.startsWith('\\\\')) {
      if (await this.fs.isDir(input)) return { ok: true, path: input };
      return { ok: false, error: `Folder does not exist: ${input}` };
    }

    const roots = this.getConfig().repoRoots ?? [];
    const candidates: Array<{ root: string; name: string }> = [];
    for (const root of roots) {
      try {
        for (const name of await this.fs.listDirs(root)) candidates.push({ root, name });
      } catch {
        // Unreachable root (WSL down) — resolve against what we can see.
      }
    }

    const lower = input.toLowerCase();
    const exact = candidates.filter((c) => c.name.toLowerCase() === lower);
    const matches = exact.length
      ? exact
      : candidates.filter((c) => c.name.toLowerCase().startsWith(lower));

    if (matches.length === 1) return { ok: true, path: join(matches[0].root, matches[0].name) };
    if (matches.length > 1) {
      const names = matches.map((m) => join(m.root, m.name)).slice(0, 5);
      return { ok: false, error: `"${input}" is ambiguous: ${names.join('; ')}` };
    }
    const sample = candidates
      .slice(0, 10)
      .map((c) => c.name)
      .join(', ');
    return {
      ok: false,
      error: `No repo named "${input}" under the known roots.${sample ? ` Known repos include: ${sample}.` : ''}`,
    };
  }
}
