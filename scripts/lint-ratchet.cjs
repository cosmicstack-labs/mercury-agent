#!/usr/bin/env node
/**
 * ESLint ratchet (P2.7).
 *
 * Runs ESLint over src/ with `--format json`, counts warnings + errors per
 * rule and compares the counts with the committed `.lint-baseline.json`.
 * The build fails when any rule's count GREW — existing violations are
 * tolerated until someone fixes them, but nobody may add new ones.
 *
 *   node scripts/lint-ratchet.cjs            # compare against the baseline
 *   node scripts/lint-ratchet.cjs --update   # rewrite the baseline from a real
 *                                            # ESLint run (after a clean-up)
 *   node scripts/lint-ratchet.cjs --estimate # best-effort grep-based baseline
 *                                            # (no ESLint needed); marks it
 *                                            # "provisional" — refresh with
 *                                            # --update at the first real run
 *
 * Rules absent from the baseline count as 0 — a provisional baseline only
 * knows about the rules it could estimate, so the first real run fails on
 * everything else; that is the moment to `--update`.
 *
 * Exported for unit tests: countByRule, compareCounts, estimateCounts,
 * formatReport.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const BASELINE_FILE = '.lint-baseline.json';
const LINT_TARGET = 'src';

/** Rule names used by the estimate; must match eslint.config.js. */
const RULE_CONSOLE = 'no-console';
const RULE_ANY = '@typescript-eslint/no-explicit-any';

/** Count ESLint JSON-formatter results per rule (errors + warnings). */
function countByRule(results) {
  const counts = {};
  for (const file of results) {
    for (const message of file.messages || []) {
      // `fatal` parse errors have no ruleId; keep them visible under one key.
      const rule = message.ruleId || (message.fatal ? '(fatal)' : '(unknown)');
      counts[rule] = (counts[rule] || 0) + 1;
    }
  }
  return sortCounts(counts);
}

function sortCounts(counts) {
  return Object.fromEntries(Object.keys(counts).sort().map((k) => [k, counts[k]]));
}

/**
 * Compare current counts with the baseline. Returns the per-rule deltas;
 * `regressions` is non-empty when any rule grew.
 */
function compareCounts(current, baseline) {
  const rules = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  const rows = [];
  for (const rule of [...rules].sort()) {
    const was = baseline[rule] || 0;
    const now = current[rule] || 0;
    rows.push({ rule, was, now, delta: now - was });
  }
  return {
    rows,
    regressions: rows.filter((r) => r.delta > 0),
    improvements: rows.filter((r) => r.delta < 0),
  };
}

function formatReport({ rows, regressions, improvements }) {
  const lines = [];
  const width = Math.max(4, ...rows.map((r) => r.rule.length));
  lines.push(`${'rule'.padEnd(width)}  baseline  current  delta`);
  for (const r of rows) {
    const mark = r.delta > 0 ? '  ← grew' : r.delta < 0 ? '  ✓ improved' : '';
    lines.push(`${r.rule.padEnd(width)}  ${String(r.was).padStart(8)}  ${String(r.now).padStart(7)}  ${(r.delta >= 0 ? '+' : '') + r.delta}${mark}`);
  }
  lines.push('');
  if (regressions.length > 0) {
    lines.push(`ratchet: ${regressions.length} rule(s) grew — fix the new violations (or, after a deliberate decision, run \`npm run lint:ratchet -- --update\`).`);
  } else if (improvements.length > 0) {
    lines.push(`ratchet: OK. ${improvements.length} rule(s) improved — lock it in with \`npm run lint:ratchet -- --update\`.`);
  } else {
    lines.push('ratchet: OK (no change).');
  }
  return lines.join('\n');
}

// ─── ESLint run ──────────────────────────────────────────────────────────────

function findEslint() {
  const local = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
  if (fs.existsSync(local)) return local;
  return null;
}

function runEslint() {
  const eslint = findEslint();
  if (!eslint) {
    console.error('lint-ratchet: eslint is not installed (node_modules/eslint missing). Run `npm ci` first.');
    process.exit(2);
  }
  const result = spawnSync(process.execPath, [eslint, LINT_TARGET, '--format', 'json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  // ESLint exits 1 when there are errors — that is expected here; anything
  // else (2 = config/usage error) is fatal.
  if (result.error) {
    console.error(`lint-ratchet: failed to run eslint: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0 && result.status !== 1) {
    console.error(result.stderr || result.stdout);
    console.error(`lint-ratchet: eslint exited with status ${result.status}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    console.error(result.stderr);
    console.error(`lint-ratchet: could not parse eslint JSON output: ${err.message}`);
    process.exit(2);
  }
  return parsed;
}

// ─── Baseline file ───────────────────────────────────────────────────────────

function readBaseline(file = path.join(root, BASELINE_FILE)) {
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!data || typeof data !== 'object' || typeof data.rules !== 'object') {
    throw new Error(`${BASELINE_FILE}: expected { "rules": { "<rule>": <count> } }`);
  }
  return data;
}

function writeBaseline(counts, { provisional, file = path.join(root, BASELINE_FILE) }) {
  const data = {
    $comment: provisional
      ? 'PROVISIONAL baseline estimated with grep (scripts/lint-ratchet.cjs --estimate); refresh with `npm run lint:ratchet -- --update` at the first real ESLint run.'
      : 'ESLint ratchet baseline. Per-rule counts (errors + warnings) may only go down. Refresh with `npm run lint:ratchet -- --update` after a clean-up.',
    provisional: Boolean(provisional),
    generatedAt: new Date().toISOString(),
    target: LINT_TARGET,
    rules: sortCounts(counts),
  };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return data;
}

// ─── Grep-based estimate (no ESLint available) ───────────────────────────────

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Mirrors the no-console exemptions in eslint.config.js. */
function isConsoleAllowed(relPath) {
  const p = relPath.split(path.sep).join('/');
  return p.startsWith('src/cli/') || p === 'src/index.ts' || /\.test\.tsx?$/.test(p) || p.includes('/__tests__/');
}

/**
 * Best-effort counts for the two rules a grep can approximate. Everything
 * else (no-unused-vars, …) is unknown and therefore 0 — the point of the
 * provisional flag.
 */
function estimateCounts(srcDir = path.join(root, LINT_TARGET)) {
  let consoleCount = 0;
  let anyCount = 0;
  for (const file of walk(srcDir)) {
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, 'utf8');
    if (!isConsoleAllowed(rel)) {
      consoleCount += (text.match(/\bconsole\.(log|error|warn|info|debug|trace|table|dir|group|groupEnd|time|timeEnd)\s*\(/g) || []).length;
    }
    // Type positions where `any` is written out: `: any`, `<any`, `as any`,
    // `any[]`, `any>`, `any,`, `any)`, `any |`, `| any`.
    anyCount += (text.match(/(?<![\w$.])any(?![\w$])(?=\s*[\]>,)|&;=\n}]|\s*\[\])|(?<=:\s*|<\s*|as\s+|\|\s*|&\s*)any(?![\w$])/g) || []).length;
  }
  return sortCounts({ [RULE_CONSOLE]: consoleCount, [RULE_ANY]: anyCount });
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main(argv) {
  const update = argv.includes('--update');
  const estimate = argv.includes('--estimate');
  const unknown = argv.filter((a) => !['--update', '--estimate'].includes(a));
  if (unknown.length > 0) {
    console.error(`lint-ratchet: unknown argument(s): ${unknown.join(', ')}`);
    return 2;
  }

  if (estimate) {
    const counts = estimateCounts();
    const data = writeBaseline(counts, { provisional: true });
    console.log(`lint-ratchet: wrote PROVISIONAL ${BASELINE_FILE} (grep estimate):`);
    for (const [rule, n] of Object.entries(data.rules)) console.log(`  ${rule.padEnd(40)} ${n}`);
    console.log('Refresh it with `npm run lint:ratchet -- --update` once ESLint runs for real.');
    return 0;
  }

  const current = countByRule(runEslint());

  if (update) {
    writeBaseline(current, { provisional: false });
    const total = Object.values(current).reduce((a, b) => a + b, 0);
    console.log(`lint-ratchet: wrote ${BASELINE_FILE} (${Object.keys(current).length} rule(s), ${total} finding(s)).`);
    return 0;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(`lint-ratchet: ${BASELINE_FILE} not found — create it with \`npm run lint:ratchet -- --update\`.`);
    return 2;
  }
  if (baseline.provisional) {
    console.log(`lint-ratchet: NOTE — ${BASELINE_FILE} is provisional (grep estimate). Refresh it with --update after this run.`);
  }
  const comparison = compareCounts(current, baseline.rules);
  console.log(formatReport(comparison));
  return comparison.regressions.length > 0 ? 1 : 0;
}

module.exports = { countByRule, compareCounts, estimateCounts, formatReport, readBaseline, writeBaseline, isConsoleAllowed };

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
