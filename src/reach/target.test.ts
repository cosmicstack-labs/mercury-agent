import { describe, expect, it } from 'vitest';
import { phoneLabel, resolvePhoneTarget } from './target.js';
import type { DeviceSummary } from '../web/devices.js';

/** "Call me on my iPhone": which paired phone the owner meant (ADR-046). */
const dev = (id: string, name: string, platform: 'ios' | 'android'): DeviceSummary => ({
  id, name, platform: 'manual', createdAt: '', lastSeenAt: null, expiresAt: null,
  reach: { platform, appVersion: '1', ring: true, notify: true, capabilities: [], updatedAt: '' },
});
const iphone = dev('ab12cd34', 'Manual token', 'ios');
const vivo = dev('ef56ab78', 'Android (vivo)', 'android');
const pixel = dev('99887766', 'Pixel 9', 'android');

describe('resolvePhoneTarget', () => {
  it('no device named: anything goes (any phone, then WhatsApp)', () => {
    expect(resolvePhoneTarget(undefined, [iphone])).toEqual({ kind: 'any' });
    expect(resolvePhoneTarget('  ', [iphone])).toEqual({ kind: 'any' });
  });

  it('"the Mercury app" / "my phone": any of their phones, not WhatsApp', () => {
    for (const q of ['Mercury app', 'the Mercury app', 'app', 'my phone']) expect(resolvePhoneTarget(q, [iphone, vivo])).toEqual({ kind: 'app', label: 'the Mercury app' });
  });

  it('by kind: iPhone / iOS → the one iPhone, Android → the one Android', () => {
    expect(resolvePhoneTarget('my iPhone', [iphone, vivo])).toEqual({ kind: 'device', deviceIds: ['ab12cd34'], label: 'your iPhone' });
    expect(resolvePhoneTarget('iOS', [iphone, vivo])).toMatchObject({ kind: 'device', deviceIds: ['ab12cd34'] });
    expect(resolvePhoneTarget('android', [iphone, vivo])).toMatchObject({ kind: 'device', deviceIds: ['ef56ab78'] });
  });

  it('by name or maker, and by id', () => {
    expect(resolvePhoneTarget('the vivo', [iphone, vivo, pixel])).toMatchObject({ kind: 'device', deviceIds: ['ef56ab78'] });
    expect(resolvePhoneTarget('Pixel 9', [iphone, vivo, pixel])).toMatchObject({ kind: 'device', deviceIds: ['99887766'] });
    expect(resolvePhoneTarget('ab12cd34', [iphone, vivo])).toMatchObject({ kind: 'device', deviceIds: ['ab12cd34'] });
  });

  it('two of the same kind, or none: asks instead of guessing', () => {
    expect(resolvePhoneTarget('android', [vivo, pixel])).toMatchObject({ kind: 'unknown', message: expect.stringMatching(/More than one Android phone/) });
    expect(resolvePhoneTarget('iPhone', [vivo])).toMatchObject({ kind: 'unknown', message: expect.stringMatching(/No iPhone is paired/) });
    expect(resolvePhoneTarget('kitchen tablet', [iphone])).toMatchObject({ kind: 'unknown' });
  });

  it('labels: the device name, else its kind', () => {
    expect(phoneLabel(iphone)).toBe('your iPhone');
    expect(phoneLabel(vivo)).toBe('"Android (vivo)"');
    expect(phoneLabel(dev('1', 'Work', 'ios'))).toBe('"Work" (iPhone)');
  });
});
