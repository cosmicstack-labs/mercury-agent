/**
 * Runtime detection of the bundled ink patch (patches/ink+5.2.1.patch /
 * scripts/apply-ink-patch.cjs).
 *
 * On stock ink the TUI's `<Static itemKey>` prop is silently ignored: the
 * transcript stops rendering new messages once the bounded window starts
 * sliding (~100 messages), and the Yoga free-node hygiene is missing (WASM
 * "memory access out of bounds" crashes). The patch is applied by
 * postinstall, which npm users never see fail — so the TUI checks for the
 * patch markers at boot and says so loudly instead of degrading silently.
 *
 * Markers, in order of trust:
 *   1. `globalThis.__mercuryFrameGate` — set by patched ink.js at module
 *      eval. Works for bundled/standalone binaries too (no file reads).
 *   2. `components/Static.js` contains `itemKey` + `setCommitTick`.
 *   3. `reconciler.js` contains `clearYogaRefs`.
 * File-based markers are only consulted when the file could be read, so a
 * standalone binary (no node_modules on disk) is judged by the gate alone.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface InkPatchStatus {
  /** True when every observable marker is present. */
  patched: boolean;
  /** Human-readable names of the missing markers (empty when patched). */
  missing: string[];
  /** Directory of the ink build that was inspected, when resolvable. */
  inkBuildDir?: string;
}

export interface InkPatchProbe {
  /** `globalThis.__mercuryFrameGate` (object when patched ink.js loaded). */
  frameGate?: unknown;
  /** Contents of ink/build/components/Static.js; null/undefined = unreadable. */
  staticSource?: string | null;
  /** Contents of ink/build/reconciler.js; null/undefined = unreadable. */
  reconcilerSource?: string | null;
}

export const INK_PATCH_MARKERS = {
  frameGate: 'freeze gate (ink.js)',
  staticItemKey: 'Static.itemKey dedup (components/Static.js)',
  yogaHygiene: 'Yoga free-node hygiene (reconciler.js)',
} as const;

/** Pure evaluation of a probe — unit-testable without touching node_modules. */
export function evaluateInkPatch(probe: InkPatchProbe): InkPatchStatus {
  const missing: string[] = [];
  if (!probe.frameGate || typeof probe.frameGate !== 'object') {
    missing.push(INK_PATCH_MARKERS.frameGate);
  }
  if (typeof probe.staticSource === 'string'
    && !(probe.staticSource.includes('itemKey') && probe.staticSource.includes('setCommitTick'))) {
    missing.push(INK_PATCH_MARKERS.staticItemKey);
  }
  if (typeof probe.reconcilerSource === 'string' && !probe.reconcilerSource.includes('clearYogaRefs')) {
    missing.push(INK_PATCH_MARKERS.yogaHygiene);
  }
  return { patched: missing.length === 0, missing };
}

/** Best-effort read of the ink build files Node would load from here. */
export function readInkSources(): Pick<InkPatchProbe, 'staticSource' | 'reconcilerSource'> & { inkBuildDir?: string } {
  try {
    const req = createRequire(import.meta.url);
    const inkBuildDir = dirname(req.resolve('ink'));
    const read = (p: string): string | null => {
      try { return readFileSync(p, 'utf8'); } catch { return null; }
    };
    return {
      inkBuildDir,
      staticSource: read(join(inkBuildDir, 'components', 'Static.js')),
      reconcilerSource: read(join(inkBuildDir, 'reconciler.js')),
    };
  } catch {
    return { staticSource: null, reconcilerSource: null };
  }
}

let cached: InkPatchStatus | null = null;

/**
 * Detect whether the running ink is patched. Cached per process; the result
 * is also mirrored to `globalThis.__mercuryInkPatchMissing` so any surface
 * (doctor, status) can report it without importing this module.
 */
export function detectInkPatch(force = false): InkPatchStatus {
  if (cached && !force) return cached;
  const sources = readInkSources();
  const status = evaluateInkPatch({
    frameGate: (globalThis as any).__mercuryFrameGate,
    staticSource: sources.staticSource,
    reconcilerSource: sources.reconcilerSource,
  });
  cached = { ...status, inkBuildDir: sources.inkBuildDir };
  (globalThis as any).__mercuryInkPatchMissing = !cached.patched;
  return cached;
}

/** Locate the shipped applier: walk up from this module (dist/ or src/ui/). */
export function findInkPatchScript(startDir: string = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = startDir;
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, 'scripts', 'apply-ink-patch.cjs');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** The one command a user should run to fix an unpatched install. */
export function inkPatchFixCommand(scriptPath: string | null = findInkPatchScript()): string {
  if (scriptPath) return `node "${scriptPath}"`;
  return 'npm install -g @cosmicstack/mercury-agent --force   (re-runs the ink patch postinstall)';
}

/** One-paragraph warning for the TUI transcript / doctor. */
export function inkPatchWarning(status: InkPatchStatus, fixCommand: string = inkPatchFixCommand()): string {
  return `⚠ Ink patch not applied (missing: ${status.missing.join('; ')}). `
    + 'On stock ink the transcript silently stops rendering new messages after ~100 and long sessions can crash '
    + '(Yoga WASM). The TUI keeps running, but to fix it run: '
    + `\`${fixCommand}\` and restart Mercury. If the script is missing, reinstall Mercury.`;
}
