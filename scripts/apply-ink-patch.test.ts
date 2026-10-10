import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requireCjs = createRequire(import.meta.url);
const { apply, isPatched, pathsFor, isVendoredPatched, VENDORED_INK_DIR } = requireCjs('../scripts/apply-ink-patch.cjs') as {
  apply: (opts?: { root?: string; inkDir?: string }) => { ok: boolean; applied: boolean; error?: string };
  isPatched: (p?: unknown) => boolean;
  pathsFor: (root: string, opts?: { inkDir?: string }) => Record<string, string>;
  isVendoredPatched: () => boolean;
  VENDORED_INK_DIR: string;
};

/**
 * The applier must patch a stock ink 8.0.0 build deterministically and fail
 * loudly when ink changes shape. These tests run it against a synthetic ink
 * tree carrying the real 8.0.0 anchors (copied verbatim from the tarball).
 */

/** Stock-shaped ink 8.0.0 files containing only the anchors the applier matches. */
function writeStockInk(root: string): void {
  const build = join(root, 'node_modules', 'ink', 'build');
  mkdirSync(join(build, 'components'), { recursive: true });
  writeFileSync(join(build, 'components', 'Static.js'), [
    "import React, { useMemo, useState, useLayoutEffect, use, } from 'react';",
    'export default function Static(props) {',
    '    const { items, children: render, style: customStyle } = props;',
    '    const [index, setIndex] = useState(0);',
    '    const itemsToRender = useMemo(() => items.slice(index), [items, index]);',
    '    useLayoutEffect(() => {',
    '        setIndex(items.length);',
    '    }, [items.length]);',
    '    return null;',
    '}',
  ].join('\n'));
  writeFileSync(join(build, 'components', 'Static.d.ts'), [
    'export type Props<T> = {',
    '    readonly items: T[];',
    '    readonly children: (item: T, index: number) => ReactNode;',
    '};',
  ].join('\n'));
  writeFileSync(join(build, 'ink.js'), [
    "import { getWindowSize } from './utils.js';",
    'const noop = () => { };',
    'export default class Ink {',
    '    onRender = () => {',
    '        const startTime = performance.now();',
    '        const { output, outputHeight, staticOutput } = render(this.rootNode, this.isScreenReaderEnabled);',
    '        const renderTime = performance.now() - startTime;',
    '        this.renderFrame(output, outputHeight, staticOutput);',
    '    };',
    '}',
  ].join('\n'));
}

describe('ink patch applier (ink 8)', () => {
  it('patches a stock synthetic ink 8 build, idempotently', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-ink-patch-'));
    try {
      writeStockInk(root);
      const result = apply({ root });
      expect(result).toEqual({ ok: true, applied: true });
      const paths = pathsFor(root);
      expect(isPatched(paths)).toBe(true);
      const inkJs = readFileSync(paths.inkJsPath, 'utf8');
      const staticJs = readFileSync(paths.staticJsPath, 'utf8');
      // Static: keyed path next to the positional one, plus the commit tick.
      expect(staticJs).toContain('const { items, children: render, style: customStyle, itemKey } = props;');
      expect(staticJs).toContain('setCommitTick((v) => v + 1);');
      expect(staticJs).toContain('return items.slice(index);');
      expect(readFileSync(paths.staticDtsPath, 'utf8')).toContain('readonly itemKey?: (item: T) => string | undefined;');
      // ink.js: the three steps run between render() and renderFrame(), in order.
      const onRender = inkJs.slice(inkJs.indexOf('onRender = () => {'));
      const gate = onRender.indexOf('frameGate.frozen');
      const trim = onRender.indexOf('Live-region guard (Cosmic Stack patch)');
      const cursor = onRender.indexOf('findCursorCell(this.rootNode, 0, 0)');
      const frame = onRender.indexOf('this.renderFrame(output, outputHeight, staticOutput);');
      expect(gate).toBeGreaterThan(0);
      expect(gate).toBeLessThan(trim);
      expect(trim).toBeLessThan(cursor);
      expect(cursor).toBeLessThan(frame);
      expect(onRender).toContain('let { output, outputHeight, staticOutput } = render(');
      expect(inkJs).toContain("hunks: ['static-item-key', 'freeze-gate', 'live-region-guard', 'cursor-anchor'],");
      expect(inkJs).toContain('vendored: false,');
      // Idempotent: a second run recognises the applied state.
      expect(apply({ root })).toEqual({ ok: true, applied: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails loudly, naming the hunk, when ink changed shape', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-ink-patch-'));
    try {
      writeStockInk(root);
      const inkJs = pathsFor(root).inkJsPath;
      writeFileSync(inkJs, readFileSync(inkJs, 'utf8').replace('render(this.rootNode, this.isScreenReaderEnabled)', 'render(this.rootNode)'));
      const result = apply({ root });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/^ink\.js: anchor not found/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('vendored ink (ADR-017)', () => {
  it('the committed vendor/ink build carries every hunk', () => {
    expect(isVendoredPatched()).toBe(true);
    const inkJs = readFileSync(join(VENDORED_INK_DIR, 'ink.js'), 'utf8');
    expect(inkJs).toContain('vendored: true');
    // Runtime-only file set: no source maps, no dangling map trailers.
    expect(inkJs).not.toContain('sourceMappingURL');
  });

  it('re-applying the patch set to the vendored build is a no-op', () => {
    expect(apply({ inkDir: VENDORED_INK_DIR })).toEqual({ ok: true, applied: false });
  });

  it('reports a missing build directory instead of throwing', () => {
    const result = apply({ inkDir: join(tmpdir(), 'mercury-no-such-ink', 'build') });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ink build not found');
  });
});
