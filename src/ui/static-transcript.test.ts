import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const uiDir = dirname(fileURLToPath(import.meta.url));
const repo = join(uiDir, '..', '..');
const read = (p: string) => readFileSync(join(repo, p), 'utf8');

/**
 * Regression guards for the Yoga WASM "memory access out of bounds" crashes
 * in Mercury Code (see ~/.mercury/crash-report.log, Sep 2026).
 *
 * Two independent defects were fixed:
 *  1. Ink's reconciler freed Yoga nodes via freeRecursive() but left every
 *     JS reference dangling — the renderer then read freed WASM memory
 *     through `node.staticNode?.yogaNode` after a mode switch unmounted
 *     <Static> (upstream only partially fixed in ink >=7; see facebook/yoga
 *     #1818 and qwen-code#7816).
 *  2. Ink's <Static> positional index assumes append-only `items`; the
 *     bounded `slice(-MAX_STATIC_MESSAGES)` window shifted the array at
 *     constant length, so new messages never rendered and every commit
 *     unmounted the entire static subtree (mass freeRecursive churn).
 */
describe('ink static-transcript crash fixes', () => {
  it('ships an ink patch that nulls freed Yoga references and clears staticNode', () => {
    const patchPath = join(repo, 'patches', 'ink+5.2.1.patch');
    expect(existsSync(patchPath)).toBe(true);
    const patch = readFileSync(patchPath, 'utf8');
    // Freed-subtree reference hygiene (reconciler).
    expect(patch).toContain('clearYogaRefs');
    expect(patch).toContain('cleanupRemovedNode');
    // ink's `#text` nodes have no childNodes array — the traversal must
    // guard (unguarded iteration crashed: "node.childNodes is not iterable").
    expect(patch).toContain('Array.isArray(node.childNodes)');
    // Dangling staticNode cache must be cleared when the removed subtree
    // contains the static node — not only when the node itself is removed.
    expect(patch).toContain('rootNode.staticNode = undefined');
    // Key-based <Static> dedup (bounded sliding windows are safe).
    expect(patch).toContain('itemKey');
  });

  it('has the patch applied to the installed ink', () => {
    // If this fails after a dependency change, the postinstall hook did not
    // run (or patches/ was lost) — every <Static> unmount is a latent crash.
    const reconciler = read('node_modules/ink/build/reconciler.js');
    expect(reconciler).toContain('clearYogaRefs');
    expect(reconciler).toContain('Array.isArray(node.childNodes)');
    expect(reconciler).toContain('rootNode.staticNode = undefined');
    const staticComponent = read('node_modules/ink/build/components/Static.js');
    expect(staticComponent).toContain('itemKey');
  });

  it('passes itemKey to every <Static> usage in App.tsx', () => {
    const app = read('src/ui/App.tsx');
    // Full JSX open tags only (comment mentions of <Static> lack `items=`).
    const usages = (app.match(/<Static[\s\S]*?>/g) ?? []).filter((m) => m.includes('items='));
    expect(usages.length).toBeGreaterThan(0);
    for (const usage of usages) {
      expect(usage, `unkeyed <Static> usage: ${usage}`).toContain('itemKey');
    }
  });
});