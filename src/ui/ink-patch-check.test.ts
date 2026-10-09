import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  evaluateInkPatch,
  findInkPatchScript,
  inkPatchFixCommand,
  inkPatchWarning,
  detectInkPatch,
  INK_PATCH_MARKERS,
} from './ink-patch-check.js';

const PATCHED_STATIC = 'export default function Static(props) { const { itemKey } = props; const [t, setCommitTick] = useState(0); }';
const STOCK_STATIC = 'export default function Static(props) { const { items, children: render } = props; }';
const PATCHED_RECONCILER = 'const clearYogaRefs = (node) => {};';
const STOCK_RECONCILER = 'const cleanupYogaNode = (node) => {};';

describe('evaluateInkPatch', () => {
  it('reports patched when the gate and both file markers are present', () => {
    const s = evaluateInkPatch({ frameGate: { frozen: false, armed: false, marker: '' }, staticSource: PATCHED_STATIC, reconcilerSource: PATCHED_RECONCILER });
    expect(s.patched).toBe(true);
    expect(s.missing).toEqual([]);
  });

  it('flags stock ink: no frame gate, positional Static, no Yoga hygiene', () => {
    const s = evaluateInkPatch({ frameGate: undefined, staticSource: STOCK_STATIC, reconcilerSource: STOCK_RECONCILER });
    expect(s.patched).toBe(false);
    expect(s.missing).toEqual([
      INK_PATCH_MARKERS.frameGate,
      INK_PATCH_MARKERS.staticItemKey,
      INK_PATCH_MARKERS.yogaHygiene,
    ]);
  });

  it('flags a half-applied patch (itemKey without the commitTick re-render)', () => {
    const s = evaluateInkPatch({ frameGate: {}, staticSource: 'const { itemKey } = props;', reconcilerSource: PATCHED_RECONCILER });
    expect(s.patched).toBe(false);
    expect(s.missing).toEqual([INK_PATCH_MARKERS.staticItemKey]);
  });

  it('judges by the frame gate alone when the ink files are unreadable (standalone binary)', () => {
    expect(evaluateInkPatch({ frameGate: {}, staticSource: null, reconcilerSource: null }).patched).toBe(true);
    expect(evaluateInkPatch({ frameGate: undefined, staticSource: null, reconcilerSource: null }).missing)
      .toEqual([INK_PATCH_MARKERS.frameGate]);
  });
});

describe('detectInkPatch (this checkout)', () => {
  it('mirrors the result to globalThis.__mercuryInkPatchMissing', () => {
    const s = detectInkPatch(true);
    expect((globalThis as any).__mercuryInkPatchMissing).toBe(!s.patched);
    expect(detectInkPatch()).toBe(s); // cached
  });
});

describe('fix command', () => {
  it('finds scripts/apply-ink-patch.cjs by walking up from a nested dir', () => {
    const root = mkdtempSync(join(tmpdir(), 'mercury-inkcheck-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      mkdirSync(join(root, 'dist', 'deep'), { recursive: true });
      writeFileSync(join(root, 'scripts', 'apply-ink-patch.cjs'), '// stub');
      const found = findInkPatchScript(join(root, 'dist', 'deep'));
      expect(found).toBe(join(root, 'scripts', 'apply-ink-patch.cjs'));
      expect(inkPatchFixCommand(found)).toBe(`node "${found}"`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to a reinstall hint when the script is not shipped', () => {
    expect(findInkPatchScript(tmpdir())).toBeNull();
    expect(inkPatchFixCommand(null)).toContain('npm install -g @cosmicstack/mercury-agent');
  });

  it('builds a single-paragraph warning naming the missing markers and the fix', () => {
    const status = evaluateInkPatch({ frameGate: undefined, staticSource: STOCK_STATIC, reconcilerSource: PATCHED_RECONCILER });
    const text = inkPatchWarning(status, 'node /x/scripts/apply-ink-patch.cjs');
    expect(text).toContain(INK_PATCH_MARKERS.frameGate);
    expect(text).toContain(INK_PATCH_MARKERS.staticItemKey);
    expect(text).toContain('node /x/scripts/apply-ink-patch.cjs');
    expect(text.split('\n')).toHaveLength(1);
  });
});
