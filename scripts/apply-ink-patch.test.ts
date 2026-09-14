import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const requireCjs = createRequire(import.meta.url);
const { apply, isPatched, pathsFor } = requireCjs('../scripts/apply-ink-patch.cjs') as {
  apply: (opts?: { root?: string }) => { ok: boolean; applied: boolean; error?: string };
  isPatched: (p?: unknown) => boolean;
  pathsFor: (root: string) => Record<string, string>;
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
  ].join('\n'));
  // Stock Static.js: no itemKey, no commitTick — the applier rewrites it wholesale.
  writeFileSync(join(build, 'components', 'Static.js'), "import React from 'react';\nexport default function Static(props) {\n    return null;\n}\n");
  writeFileSync(join(build, 'components', 'Static.d.ts'), '    readonly children: (item: T, index: number) => ReactNode;\n};\n');
  writeFileSync(join(build, 'ink.js'), [
    'import logUpdate from \'./log-update.js\';',
    'const noop = () => { };',
    'export default class Ink {',
    '    onRender() {',
    '        const { output, outputHeight, staticOutput } = render(this.rootNode);',
    '        const hasStaticOutput = staticOutput && staticOutput !== \'\\n\';',
    '    }',
    '}',
  ].join('\n'));
  writeFileSync(join(build, 'log-update.js'), [
    'const create = (stream, { showCursor = false } = {}) => {',
    '    let previousLineCount = 0;',
    '    let previousOutput = \'\';',
    '    const render = (str) => {',
    "        const output = str + '\\n';",
    '        if (output === previousOutput) {',
    '            return;',
    '        }',
    '        previousOutput = output;',
    '        stream.write(ansiEscapes.eraseLines(previousLineCount) + output);',
    "        previousLineCount = output.split('\\n').length;",
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
      // Idempotent: a second run must recognize the applied state and no-op.
      const again = apply({ root });
      expect(again.ok).toBe(true);
      expect(again.applied).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});