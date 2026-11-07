import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SaverMode } from './saver-mode.js';
import { saveConfig, type MercuryConfig } from '../utils/config.js';

vi.mock('../utils/config.js', () => ({ saveConfig: vi.fn() }));

const config = () => ({ tokens: { dailyBudget: 1_000, saverMode: false, saverAutoThreshold: 75, saverAutoEnabled: true } } as MercuryConfig);
beforeEach(() => { vi.mocked(saveConfig).mockClear(); });

describe('saver session snapshots', () => {
  it('copies runtime state and notification progress without sharing consumption', () => {
    const root = new SaverMode(config());
    root.evaluateAuto(80);
    root.setRoutingEnabled(true);
    expect(root.consumeAutoActivationNotice()).toBeTruthy();
    expect(root.consumePostActivationHint()).toBeTruthy();

    const fork = root.fork();
    expect(fork.getState()).toBe('auto');
    expect(fork.isRoutingEnabled()).toBe(true);
    expect(fork.getAutoThreshold()).toBe(75);
    expect(fork.isAutoEnabled()).toBe(true);
    expect(fork.consumeAutoActivationNotice()).toBeNull();
    expect(fork.consumePostActivationHint()).toBeTruthy();
    expect(fork.consumePostActivationHint()).toBeNull();
    expect(root.consumePostActivationHint()).toBeTruthy();
    expect(root.consumePostActivationHint()).toBeNull();

    fork.evaluateAuto(50);
    expect(fork.isActive()).toBe(false);
    expect(root.getState()).toBe('auto');
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('keeps fork commands and settings local without persisting or mutating root config', () => {
    const cfg = config();
    const original = structuredClone(cfg);
    const root = new SaverMode(cfg);
    const fork = root.fork();
    fork.enable();
    expect(root.isActive()).toBe(false);
    fork.disable();
    fork.toggle();
    fork.setAutoThreshold(40);
    fork.setAutoEnabled(false);
    fork.setRoutingEnabled(true);
    expect(fork.isActive()).toBe(true);
    expect(fork.getAutoThreshold()).toBe(40);
    expect(fork.isAutoEnabled()).toBe(false);
    expect(root.getAutoThreshold()).toBe(75);
    expect(root.isAutoEnabled()).toBe(true);
    expect(root.isRoutingEnabled()).toBe(false);
    expect(cfg).toEqual(original);
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it('preserves legacy root persistence without changing an already-forked snapshot', () => {
    const cfg = config();
    const root = new SaverMode(cfg);
    const fork = root.fork();
    root.enable();
    root.setAutoThreshold(40);
    root.setAutoEnabled(false);
    expect(saveConfig).toHaveBeenCalledTimes(3);
    expect(saveConfig).toHaveBeenLastCalledWith(cfg);
    expect(fork.isActive()).toBe(false);
    expect(fork.getAutoThreshold()).toBe(75);
    expect(fork.isAutoEnabled()).toBe(true);
  });
});
