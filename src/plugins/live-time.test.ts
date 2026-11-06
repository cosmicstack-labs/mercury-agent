import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runConformance } from './conformance.js';
import type { PluginContext, PluginToolDefinition } from './sdk.js';

const entry = pathToFileURL(resolve('plugins/live-time/index.mjs')).href;
const { currentTime, activate } = await import(entry);

describe('Mercury current-time source plugin', () => {
  it('passes native manifest and lifecycle conformance', async () => {
    const report = await runConformance(resolve('plugins/live-time'));
    expect(report.checks.filter((check) => !check.ok)).toEqual([]);
    expect(report.ok).toBe(true);
  });
  it('registers an executable read-only lookup without needing other SDK surfaces', () => {
    const registered: PluginToolDefinition[] = [];
    activate({ tools: { register(tool: PluginToolDefinition) { registered.push(tool); return { dispose() {} }; } } } as PluginContext);
    expect(registered.map((tool) => tool.name)).toEqual(['now']);
    expect(registered[0].inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(registered[0].execute({}, { signal: new AbortController().signal })).toMatchObject({ ok: true, clock_source: 'host-system-clock' });
  });
  it('returns the UTC instant and correct Chicago winter date across midnight', () => {
    const now = new Date('2026-11-06T02:00:00.000Z');
    expect(currentTime({ timezone: 'America/Chicago' }, now)).toMatchObject({
      ok: true, utc: now.toISOString(), epoch_ms: now.getTime(),
      timezone: 'America/Chicago', local: '2026-11-05T20:00:00', weekday: 'Thursday', offset: 'GMT-06:00',
    });
  });
  it('uses daylight-saving offset for a summer instant', () => {
    expect(currentTime({ timezone: 'America/Chicago' }, new Date('2026-07-01T12:00:00Z')))
      .toMatchObject({ ok: true, local: '2026-07-01T07:00:00', offset: 'GMT-05:00' });
  });
  it('preserves fractional-hour timezone offsets', () => {
    expect(currentTime({ timezone: 'Asia/Kathmandu' }, new Date('2026-11-05T00:00:00Z')))
      .toMatchObject({ ok: true, local: '2026-11-05T05:45:00', offset: 'GMT+05:45' });
  });
  it('defaults to the runtime zone without asserting an owner timezone', () => {
    expect(currentTime({}, new Date('2026-11-05T00:00:00Z')))
      .toMatchObject({ ok: true, timezone: new Intl.DateTimeFormat().resolvedOptions().timeZone });
  });
  it.each([null, [], 'UTC', { timezone: '' }, { timezone: 42 }, { timezone: 'not/a-zone' },
    { timezone: 'x'.repeat(101) }, { extra: true }])('rejects unsupported arguments: %j', (args) => {
    expect(currentTime(args)).toMatchObject({ ok: false, error: expect.any(String) });
  });
  it('reports invalid clock data', () => {
    expect(currentTime({}, new Date('invalid'))).toMatchObject({ ok: false });
  });
});
