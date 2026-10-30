import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// ADR-017: tests run against the same vendored, patched ink the bundle
// ships (vendor/ink), never the stock copy in node_modules.
export default defineConfig({
  // apps/* run their own test config (their own aliases and environment).
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'] },
  resolve: {
    alias: [
      { find: /^ink$/, replacement: fileURLToPath(new URL('./vendor/ink/build/index.js', import.meta.url)) },
    ],
  },
});
