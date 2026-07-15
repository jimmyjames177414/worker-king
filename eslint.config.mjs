import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Lean flat config: typescript-eslint's non-type-checked recommended set (fast,
 * no project graph) over the packages' src. Prettier owns formatting, so
 * eslint-config-prettier disables any stylistic rules that would conflict. Keep
 * this minimal — tighten rules deliberately rather than adopting a large ruleset
 * that forces a churny first pass.
 */
export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/*.d.ts', 'graphify-out/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // Allow intentionally-unused args/vars when prefixed with underscore.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // The WS bus + SDK boundaries legitimately traffic in `any`; warn, don't block.
      '@typescript-eslint/no-explicit-any': 'warn',
      // The SDK streaming-input pattern uses generators that intentionally never
      // yield (a pending-input stream that just holds the session open until abort).
      'require-yield': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
