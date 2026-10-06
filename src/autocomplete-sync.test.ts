import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// This test lives in src/, so dirname is already the src directory.
const root = dirname(fileURLToPath(import.meta.url));
const appSrc = readFileSync(join(root, 'ui', 'App.tsx'), 'utf8');
const composerSrc = readFileSync(join(root, 'ui', 'input-composer.tsx'), 'utf8');
const attachSrc = readFileSync(join(root, 'ui', 'attach-tui.tsx'), 'utf8');
const manualSrc = readFileSync(join(root, 'utils', 'manual.ts'), 'utf8');

/**
 * Slash-command sync contract: every real chat command must appear in the
 * canonical autocomplete list (ui/input-composer.tsx `SLASH_COMMANDS`) and in
 * the manual. Since the shared composer was extracted, App.tsx and the attach
 * TUI import THE SAME list — the contract pins that wiring too: if either
 * surface stops importing the composer, suggestions silently diverge again
 * (the "close & relaunch feels different" class of bug).
 */
describe('slash autocomplete & help stay in sync', () => {
  it('both TUI surfaces consume the shared input composer', () => {
    for (const src of [appSrc, attachSrc]) {
      expect(src).toContain("from './input-composer.js'");
      expect(src).toContain('SLASH_COMMANDS');
      expect(src).toContain('SuggestionList');
    }
  });

  it('the canonical autocomplete list covers the recently added commands', () => {
    for (const cmd of [
      '/whatsnew',
      '/update ignore',
      '/log',
      '/code chat',
      '/code back',
    ]) {
      expect(composerSrc).toContain(`'${cmd}'`);
    }
  });

  it('the manual documents the background-task, model, and budget commands', () => {
    for (const entry of [
      "['/bg current',",
      "['/bg list',",
      "['/bg cancel <id>',",
      "['/bg clear',",
      "['/bg killall',",
      "['/budget',",
      "['/models',",
      "['/models use <provider>',",
      "['/cloud models',",
      "['/cloud use <model-id>',",
      "['/log',",
    ]) {
      expect(manualSrc).toContain(entry);
    }
  });

  it('dead commands are not documented (no dispatcher → no manual entry)', () => {
    // /tasks was documented but never dispatched — removed.
    expect(manualSrc).not.toContain("['/tasks',");
  });

  it('the channel help texts mention the new commands', () => {
    // Telegram + Discord share the same list layout; Slack uses /mercury prefix.
    for (const marker of ['whatsnew', 'update ignore', '/bg current']) {
      expect(manualSrc).toContain(marker);
    }
    expect(manualSrc).toContain('/mercury whatsnew');
  });
});