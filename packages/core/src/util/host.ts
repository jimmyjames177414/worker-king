import { readFileSync } from 'node:fs';
import { platform } from 'node:os';

export type DaemonHost = 'windows' | 'wsl' | 'unknown';

/**
 * Detect where this daemon process is running. Used only to label the `welcome`
 * message; the actual Windows-vs-WSL spawn decision is made by Electron main's
 * DaemonSupervisor. WSL is detected via the `microsoft`/`WSL` marker the kernel
 * writes into /proc/version.
 */
export function detectHost(): DaemonHost {
  if (platform() === 'win32') return 'windows';
  if (platform() === 'linux') {
    try {
      const version = readFileSync('/proc/version', 'utf8').toLowerCase();
      if (version.includes('microsoft') || version.includes('wsl')) return 'wsl';
    } catch {
      // not readable — fall through
    }
  }
  return 'unknown';
}
