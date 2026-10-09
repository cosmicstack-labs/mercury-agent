// ESLint flat config (P2.7).
//
// Scope: src/**/*.{ts,tsx} only. Build scripts, the web dashboard (ui/),
// the website and generated output are not linted here.
//
// Rules of note:
//   - no-console is an error everywhere except the CLI surface
//     (src/cli/**, src/index.ts) and tests — application code logs through
//     src/utils/logger.ts;
//   - @typescript-eslint/no-explicit-any is a warning, budgeted by the
//     ratchet (scripts/lint-ratchet.cjs against .lint-baseline.json).
//
// The ratchet means an existing violation is tolerated until it is fixed,
// but no rule's count may grow.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'release/**',
      'ui/**',
      'website/**',
      'vendor/**',
      'coverage/**',
      'scripts/**',
      'patches/**',
      '*.config.*',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
      // `catch {}` is the codebase's idiom for best-effort cleanup.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // CLI surface and tests talk to the terminal directly.
    files: [
      'src/cli/**/*.{ts,tsx}',
      'src/index.ts',
      'src/**/*.test.{ts,tsx}',
      'src/**/__tests__/**/*.{ts,tsx}',
    ],
    rules: {
      'no-console': 'off',
    },
  },
);
