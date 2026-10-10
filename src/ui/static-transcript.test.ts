import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
  it('ships ink 8, whose own reconciler nulls freed Yoga references and clears staticNode', () => {
    // Defect 1 is fixed upstream since ink 8 (freeYogaSubtree +
    // clearStaticNodeIfContained), so Mercury no longer patches it. Guard
    // against a downgrade that would bring the crash back.
    expect(JSON.parse(read('vendor/ink/package.json')).version).toBe('8.0.0');
    const dom = read('vendor/ink/build/dom.js');
    expect(dom).toContain('nullifyYogaNodes(removedNode)');
    const reconciler = read('vendor/ink/build/reconciler.js');
    expect(reconciler).toContain('clearStaticNodeIfContained(findRootNode(node), removedNode)');
    expect(reconciler).toContain('freeYogaSubtree(removedNode)');
  });

  it('has the key-based <Static> patch applied to the vendored ink that ships in the bundle', () => {
    // Defect 2 is still Mercury's patch. If this fails, regenerate with
    // `node scripts/vendor-ink.cjs`.
    expect(read('patches/ink+8.0.0.patch')).toContain('itemKey');
    const staticComponent = read('vendor/ink/build/components/Static.js');
    expect(staticComponent).toContain('itemKey');
    expect(staticComponent).toContain('setCommitTick');
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