import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runConformance } from './conformance.js';
import type { PluginContext, PluginToolDefinition } from './sdk.js';

const entry = pathToFileURL(resolve('plugins/hardlight/index.mjs')).href;
const { contrast, navigation, activate } = await import(entry);

describe('Mercury Hardlight plugin contract', () => {
  it('registers executable schemas for both tools using only the SDK tools surface', () => {
    const registered: PluginToolDefinition[] = [];
    activate({ tools: { register: (tool: PluginToolDefinition) => { registered.push(tool); return { dispose() {} }; } } } as PluginContext);
    expect(registered.map((t) => t.name)).toEqual(['contrast', 'navigation']);
    for (const tool of registered) expect(tool.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(registered[0].execute({ pairs: [{ foreground: '#000', background: '#fff', role: 'text' }] }, { signal: new AbortController().signal }))
      .toMatchObject({ ok: true });
  });
  it('passes native manifest, start/stop and hot-restart conformance', async () => {
    const report = await runConformance(resolve('plugins/hardlight'));
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

describe('Mercury Hardlight contrast', () => {
  it('measures opaque sRGB with role-specific thresholds', () => {
    const result = contrast({ pairs: [
      { foreground: '#000', background: '#fff', role: 'text' },
      { foreground: '#fff', background: '#fff', role: 'ui' },
      { foreground: '#777', background: '#fff', role: 'large_text' },
    ] });
    expect(result.ok).toBe(true);
    expect(result.pairs[0]).toMatchObject({ ratio: 21, threshold: 4.5, status: 'pass' });
    expect(result.pairs[1]).toMatchObject({ ratio: 1, threshold: 3, status: 'fail' });
    expect(result.pairs[2].status).toBe('pass');
  });
  it.each([null, {}, { pairs: [] }, { pairs: Array(101).fill({}) },
    { pairs: [{ foreground: '#0000', background: '#fff', role: 'text' }] },
    { pairs: [{ foreground: '#000', background: '#fff', role: 'toString' }] },
    { pairs: [{ foreground: '#000', background: '#fff', role: 'text', label: 1 }] },
  ])('rejects unsupported contrast input atomically: %j', (args) => {
    expect(contrast(args)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});

const pages = [
  { id: 'home', label: 'Home', links: [{ to: 'item', label: 'Open' }, { to: 'missing', label: 'Open' }] },
  { id: 'item', label: 'Item', links: [] },
  { id: 'orphan', label: 'Orphan', links: [] },
];
describe('Mercury Hardlight navigation', () => {
  it('reports shortest paths, missing targets, ambiguous labels and unreachable pages', () => {
    const result = navigation({ pages, tasks: [
      { name: 'Open', start: 'home', goal: 'item', max_steps: 0 },
      { name: 'Unreachable', start: 'item', goal: 'home' },
    ] });
    expect(result.ok).toBe(true);
    expect(result.tasks[0]).toMatchObject({ path: ['home', 'item'], steps: 1, over_budget: true });
    expect(result.tasks[1]).toMatchObject({ path: null, steps: null, reachable: false, over_budget: null });
    expect(result.unknown_targets).toEqual([{ source: 'home', to: 'missing', label: 'Open' }]);
    expect(result.ambiguous_labels).toEqual([{ source: 'home', label: 'Open', targets: ['item', 'missing'] }]);
    expect(result.unreachable_pages).toEqual(['orphan']);
    expect(result.dead_ends).toEqual(['orphan']);
    expect(result.coverage).toEqual({ page_count: 3, edge_count: 2, known_edge_count: 1 });
  });
  it('handles prototype-like IDs, cycles and zero-edge tasks without guessing budgets', () => {
    const result = navigation({ pages: [
      { id: '__proto__', label: 'Start', links: [{ to: 'constructor', label: 'Next' }] },
      { id: 'constructor', label: 'End', links: [{ to: '__proto__', label: 'Back' }] },
    ], tasks: [{ name: 'Stay', start: '__proto__', goal: '__proto__', max_steps: 0 }] });
    expect(result.ok).toBe(true);
    expect(result.tasks[0]).toMatchObject({ steps: 0, over_budget: false, path: ['__proto__'] });
  });
  it.each([null, {}, { pages: [], tasks: [] }, { pages, tasks: [], home: 'missing' },
    { pages: [pages[0], pages[0]], tasks: [] },
    { pages, tasks: [{ name: 'Bad', start: 'home', goal: 'item', max_steps: true }] },
    { pages, tasks: [{ name: 'Bad', start: 'none', goal: 'item' }] },
    { pages: Array(301).fill(pages[0]), tasks: [] },
    { pages, tasks: Array(101).fill({ name: 'Open', start: 'home', goal: 'item' }) },
  ])('rejects malformed or oversized navigation input: %j', (args) => {
    expect(navigation(args)).toMatchObject({ ok: false, error: expect.any(String) });
  });
});
