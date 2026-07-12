import { safeStorage } from 'electron';
import Store from 'electron-store';

/**
 * Secrets — OS-keychain-backed secret storage.
 *
 * Uses Electron's `safeStorage` (DPAPI on Windows) to encrypt values, storing
 * only ciphertext in electron-store. API keys (e.g. OPENAI_API_KEY for the
 * Realtime provider) never touch the plaintext config.json. Claude auth is
 * inherited by the Agent SDK from the user's login and is not stored here.
 */
const secretStore = new Store<Record<string, string>>({ name: 'secrets' });

export function setSecret(key: string, value: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS secret encryption is not available on this system');
  }
  const encrypted = safeStorage.encryptString(value).toString('base64');
  secretStore.set(key, encrypted);
}

export function getSecret(key: string): string | undefined {
  const encrypted = secretStore.get(key);
  if (!encrypted) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'));
  } catch {
    return undefined;
  }
}

export function hasSecret(key: string): boolean {
  return secretStore.has(key);
}

export function deleteSecret(key: string): void {
  secretStore.delete(key);
}
