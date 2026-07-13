import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface ClaudeLocation {
  /** Where a working `claude` binary was found. */
  host: 'windows' | 'wsl' | 'none';
  /** WSL distro that has claude, if host === 'wsl'. */
  distro?: string;
  /** Resolved path to the claude binary. */
  path?: string;
}

/**
 * Decide where the Claude backend should run.
 *
 * Probes native Windows first (`where claude`), then the default WSL distro
 * (`wsl.exe -e which claude`). Returns the first hit. This drives the
 * DaemonSupervisor's mode when config.claudeHost is 'auto'.
 *
 * Only meaningful on Windows; on other platforms it returns a local probe.
 */
export async function detectClaude(): Promise<ClaudeLocation> {
  if (process.platform === 'win32') {
    const win = await probeWindows();
    if (win) return { host: 'windows', path: win };

    const wsl = await probeWsl();
    if (wsl) return { host: 'wsl', distro: wsl.distro, path: wsl.path };

    return { host: 'none' };
  }

  // Non-Windows dev: probe the local PATH.
  const local = await probeUnix();
  return local ? { host: 'wsl', path: local } : { host: 'none' };
}

async function probeWindows(): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('where', ['claude']);
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first?.trim();
  } catch {
    return undefined;
  }
}

async function probeWsl(): Promise<{ distro?: string; path: string } | undefined> {
  try {
    const { stdout } = await pexec('wsl.exe', ['-e', 'bash', '-lc', 'which claude']);
    const path = stdout.trim();
    return path ? { path } : undefined;
  } catch {
    return undefined;
  }
}

async function probeUnix(): Promise<string | undefined> {
  try {
    const { stdout } = await pexec('which', ['claude']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
