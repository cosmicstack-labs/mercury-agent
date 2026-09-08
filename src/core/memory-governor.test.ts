import { describe, expect, it } from 'vitest';
import {
  memoryGovernorThresholds,
  memoryGovernorVerdict,
  summarizeToolResult,
  CONVERSATION_TOOL_BUDGET_CHARS,
  TOOL_RESULT_KEEP_RECENT,
  TOOL_RESULT_SUMMARY_CHARS,
} from './memory-governor.js';

const MB = 1024 * 1024;

describe('memory governor thresholds', () => {
  it('orders relief < abort < exit on a standard heap', () => {
    const t = memoryGovernorThresholds({ heapSizeLimit: 2096 * MB, baselineHeapUsed: 120 * MB });
    expect(t.reliefBytes).toBeLessThan(t.abortBytes);
    expect(t.abortBytes).toBeLessThan(t.exitBytes);
    expect(t.exitBytes).toBeLessThan(2096 * MB);
  });

  it('keeps thresholds below the V8 limit even on small heaps', () => {
    const t = memoryGovernorThresholds({ heapSizeLimit: 512 * MB, baselineHeapUsed: 100 * MB });
    expect(t.exitBytes).toBeLessThanOrEqual(512 * MB);
    expect(t.abortBytes).toBeLessThan(t.exitBytes);
  });

  it('verdicts escalate monotonically with heap growth', () => {
    const t = memoryGovernorThresholds({ heapSizeLimit: 2096 * MB, baselineHeapUsed: 120 * MB });
    expect(memoryGovernorVerdict(0, t)).toBe('ok');
    expect(memoryGovernorVerdict(t.reliefBytes, t)).toBe('relief');
    expect(memoryGovernorVerdict(t.abortBytes, t)).toBe('abort');
    expect(memoryGovernorVerdict(t.exitBytes, t)).toBe('exit');
    expect(memoryGovernorVerdict(t.reliefBytes - 1, t)).toBe('ok');
    expect(memoryGovernorVerdict(t.abortBytes - 1, t)).toBe('relief');
    expect(memoryGovernorVerdict(t.exitBytes - 1, t)).toBe('abort');
  });
});

describe('conversation budget helpers', () => {
  it('leaves small tool results untouched', () => {
    const small = 'x'.repeat(100);
    expect(summarizeToolResult(small)).toBe(small);
  });

  it('compacts oversized results to a bounded head+tail summary', () => {
    const big = 'a'.repeat(TOOL_RESULT_SUMMARY_CHARS) + 'b'.repeat(10 * MB) + 'c'.repeat(TOOL_RESULT_SUMMARY_CHARS);
    const summarized = summarizeToolResult(big);
    expect(summarized.length).toBeLessThan(TOOL_RESULT_SUMMARY_CHARS * 2 + 300);
    expect(summarized.startsWith('a')).toBe(true);
    expect(summarized.endsWith('c')).toBe(true);
    expect(summarized).toContain('memory governor');
  });

  it('budget constants are sane', () => {
    expect(CONVERSATION_TOOL_BUDGET_CHARS).toBe(512 * 1024);
    expect(TOOL_RESULT_KEEP_RECENT).toBeGreaterThanOrEqual(4);
  });
});