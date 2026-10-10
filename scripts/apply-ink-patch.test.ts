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
 * The bundled ink fixes (Yoga WASM hygiene, Static identity dedup, freeze
 * gate, live-region guard, log-update diff-render) must be applicable
 * WITHOUT patch-package — that is exactly what failed on Termux CI
 * (`sh: 1: patch-package: not found`) and left stock ink's clearTerminal
 * fallback live, failing the live-region-guard tests. These tests run the
 * applier against a synthetic ink tree carrying the real 5.2.1 anchors.
 */

/** Stock-shaped ink 5.2.1 files containing only the anchors the applier matches. */
function writeStockInk(root: string): void {
  const build = join(root, 'node_modules', 'ink', 'build');
  mkdirSync(join(build, 'components'), { recursive: true });
  writeFileSync(join(build, 'reconciler.js'), [
    'import { appendChildNode, insertBeforeNode, removeChildNode } from "./dom.js";',
    'const cleanupYogaNode = (node) => {',
    '    node?.unsetMeasureFunc();',
    '    node?.freeRecursive();',
    '};',
    'const somethingElse = (node) => {',
    '        removeChildNode(node, removeNode);',
    '        cleanupYogaNode(removeNode.yogaNode);',
    '};',
    '        removeChildNode(node, removeNode);',
    '        cleanupYogaNode(removeNode.yogaNode);',
    '};',
    'export default createReconciler({',
    '});',
  ].join('\n'));
  // Stock Static.js: no itemKey, no commitTick — the applier rewrites it wholesale.
  writeFileSync(join(build, 'components', 'Static.js'), "import React from 'react';\nexport default function Static(props) {\n    return null;\n}\n");
  writeFileSync(join(build, 'components', 'Static.d.ts'), '    readonly children: (item: T, index: number) => ReactNode;\n};\n');
  writeFileSync(join(build, 'ink.js'), [
    'import logUpdate from \'./log-update.js\';',
    'const noop = () => { };',
    'export default class Ink {',
    '    constructor(options) {',
    '        this.log = logUpdate.create(options.stdout);',
    '    }',
    '    resized = () => {',
    '        this.calculateLayout();',
    '        this.onRender();',
    '    };',
    '    onRender = () => {',
    '        const { output, outputHeight, staticOutput } = render(this.rootNode);',
    '        const hasStaticOutput = staticOutput && staticOutput !== \'\\n\';',
    '        if (hasStaticOutput) {',
    '            this.log.clear();',
    '            this.options.stdout.write(staticOutput);',
    '            this.log(output);',
    '        }',
    '        if (!hasStaticOutput && output !== this.lastOutput) {',
    '            this.throttledLog(output);',
    '        }',
    '        this.lastOutput = output;',
    '    };',
    '    writeToStdout(data) {',
    '        this.log.clear();',
    '        this.options.stdout.write(data);',
    '        this.log(this.lastOutput);',
    '    }',
    '}',
  ].join('\n'));
  writeFileSync(join(build, 'log-update.js'), [
    'const create = (stream, { showCursor = false } = {}) => {',
    '    let previousLineCount = 0;',
    '    let previousOutput = \'\';',
    '    let hasHiddenCursor = false;',
    '    const render = (str) => {',
    "        const output = str + '\\n';",
    '        if (output === previousOutput) {',
    '            return;',
    '        }',
    '        previousOutput = output;',
    '        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);',
    "        previousLineCount = output.split('\\n').length;",
    '    };',
    '    render.clear = () => {',
    '        stream.write(ansiEscapes.eraseLines(previousLineCount));',
    '    };',
    '    render.done = () => {',
    '    };',
    '    return render;',
    '};',
  ].join('\n'));
}

describe('ink patch applier (patch-package-free)', () => {
  it('fully patches a stock synthetic ink install — no patch-package needed', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-ink-patch-'));
    try {
      writeStockInk(root);
      const result = apply({ root });
      expect(result.ok).toBe(true);
      expect(result.applied).toBe(true);
      expect(result.error).toBeUndefined();
      expect(isPatched(pathsFor(root))).toBe(true);
      const paths = pathsFor(root);
      const inkJs = readFileSync(paths.inkJsPath, 'utf8');
      const logUpdate = readFileSync(paths.logUpdatePath, 'utf8');
      // Resize baseline reset: resized() drops both diff baselines BEFORE
      // the re-layout + render, and log-update exposes the invalidate hook.
      expect(logUpdate).toContain('render.invalidate = () => {');
      const resized = inkJs.slice(inkJs.indexOf('resized = () => {'), inkJs.indexOf('onRender() {'));
      expect(resized).toContain("this.lastOutput = '';");
      expect(resized).toContain('this.log.invalidate()');
      expect(resized.indexOf('this.log.invalidate()')).toBeLessThan(resized.indexOf('this.calculateLayout()'));
      // Hardware cursor: every frame write unparks first and parks after
      // (through syncWrite, see the synchronized-output checks below),
      // and both log() call sites pass the resolved cell through.
      expect(logUpdate).toContain('const render = (str, cursor) => {');
      expect(inkJs).toContain('this.log(output, cursor);');
      expect(inkJs).toContain('this.throttledLog(output, cursor);');
      expect(inkJs).toContain('this.log(this.lastOutput, this.lastCursor);');
      expect(inkJs).toContain('node.attributes?.internal_cursor');
      expect(readFileSync(paths.reconcilerPath, 'utf8')).toContain('globalThis.__mercuryInkYogaHygiene = true;');
      // Synchronized output: log-update brackets its own writes, ink.js
      // brackets clear + static + frame as one update, gated on a TTY.
      expect(logUpdate).toContain('syncWrite(unpark() + ansiEscapes.eraseLines(eraseCount)');
      expect(logUpdate).toContain('syncWrite(unpark() + ansiEscapes.eraseLines(previousLineCount))');
      expect(logUpdate).not.toContain('stream.write(unpark()');
      expect(inkJs).toContain('synchronize: Boolean(options.stdout.isTTY) && !isInCi && !options.debug');
      expect(inkJs).toMatch(/this\.synchronized\(\(\) => \{\n\s+this\.log\.clear\(\);\n\s+this\.options\.stdout\.write\(staticOutput\);/);
      // Idempotent: a second run must recognize the applied state and no-op.
      const again = apply({ root });
      expect(again.ok).toBe(true);
      expect(again.applied).toBe(false);
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
