import { describe, expect, it } from 'vitest';
import { applyHeadlessSetup } from './headless-setup.js';
import type { MercuryConfig } from '../utils/config.js';

function fresh(): MercuryConfig {
  return {
    identity: { owner: '', name: '' },
    web: { enabled: false, port: 6174 },
  } as unknown as MercuryConfig;
}

describe('mercury setup --headless', () => {
  it('turns an empty config into a runnable one with the dashboard on', () => {
    const config = fresh();
    const { changed } = applyHeadlessSetup(config, { owner: 'Salman' });
    expect(config.identity.owner).toBe('Salman');
    expect(config.identity.name).toBe('Mercury');
    expect(config.web.enabled).toBe(true);
    expect(changed).toEqual(['identity.owner', 'identity.name', 'web.enabled']);
  });

  it('never blanks a name that is already set, and only touches what the flags name', () => {
    const config = fresh();
    config.identity.owner = 'Existing';
    config.identity.name = 'Hermes';
    config.web.enabled = true;
    const { changed } = applyHeadlessSetup(config, {});
    expect(config.identity.owner).toBe('Existing');
    expect(config.identity.name).toBe('Hermes');
    expect(changed).toEqual([]);
  });

  it('sets the port when asked and rejects a bad one', () => {
    const config = fresh();
    applyHeadlessSetup(config, { owner: 'A', port: 7000 });
    expect(config.web.port).toBe(7000);
    expect(() => applyHeadlessSetup(fresh(), { owner: 'A', port: 70000 })).toThrow(/Invalid port/);
  });

  it('strips control characters from names', () => {
    const config = fresh();
    applyHeadlessSetup(config, { owner: ' Sal\u0007man ' });
    expect(config.identity.owner).toBe('Salman');
  });
});
