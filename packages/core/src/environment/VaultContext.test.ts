import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { VaultContext, type VaultFs } from './VaultContext.js';

const VAULT = '\\\\wsl\\repos\\Amethyst\\.local\\.context2';

function fakeFs(files: Record<string, string>): VaultFs {
  return {
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
  };
}

const fence = (label: string, text: string) => `<untrusted:${label}>${text}</untrusted>`;

function build(files: Record<string, string>, path: string | undefined) {
  return new VaultContext(() => path, { fs: fakeFs(files), fence, now: () => 0 });
}

describe('VaultContext', () => {
  it('is empty when no vault is configured', () => {
    expect(build({}, undefined).vaultBlock()).toBe('');
  });

  it('folds hot cache + index excerpts in, fenced as untrusted', async () => {
    const vault = build(
      {
        [join(VAULT, 'wiki', 'hot.md')]: 'Recently: shipped the daemon refactor.',
        [join(VAULT, 'wiki', 'index.md')]: '# Index\n- [[projects]]\n- [[people]]',
      },
      VAULT,
    );
    await vault.refresh();
    const block = vault.vaultBlock();
    expect(block).toContain(`Global knowledge vault: ${VAULT}`);
    expect(block).toContain('<untrusted:vault-hot-cache>Recently: shipped the daemon refactor.');
    expect(block).toContain('<untrusted:vault-index># Index');
    expect(block).toContain('consult the vault first');
    expect(block).toContain('.vault-meta/locks');
  });

  it('caps long excerpts', async () => {
    const vault = new VaultContext(() => VAULT, {
      fs: fakeFs({ [join(VAULT, 'wiki', 'hot.md')]: 'x'.repeat(10_000) }),
      fence,
      now: () => 0,
      hotCapChars: 100,
    });
    await vault.refresh();
    const block = vault.vaultBlock();
    expect(block.length).toBeLessThan(1000);
  });

  it('degrades to a note when the vault is unreachable (WSL down)', async () => {
    const vault = build({}, VAULT); // no files at all → both reads fail
    await vault.refresh();
    const block = vault.vaultBlock();
    expect(block).toContain('unreachable right now');
    expect(block).toContain('Global knowledge vault');
  });

  it('never blocks the prompt path before the first read completes', () => {
    const vault = build({ [join(VAULT, 'wiki', 'hot.md')]: 'hi' }, VAULT);
    // No refresh() awaited — synchronous call still returns immediately.
    expect(vault.vaultBlock()).toContain('still loading');
  });
});
