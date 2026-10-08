import { describe, expect, it } from 'vitest';
import { detectTerminalTheme } from './terminal-theme.js';

describe('terminal theme detection', () => {
  it('reads the background from COLORFGBG', () => {
    expect(detectTerminalTheme({ COLORFGBG: '15;0' })).toBe('dark');
    expect(detectTerminalTheme({ COLORFGBG: '0;15' })).toBe('light');
    expect(detectTerminalTheme({ COLORFGBG: '0;7' })).toBe('light');
    expect(detectTerminalTheme({ COLORFGBG: '0;default;15' })).toBe('light');
    expect(detectTerminalTheme({ COLORFGBG: '7;8' })).toBe('dark');
  });

  it('defaults to dark when the terminal says nothing', () => {
    expect(detectTerminalTheme({})).toBe('dark');
    expect(detectTerminalTheme({ COLORFGBG: 'garbage' })).toBe('dark');
  });

  it('lets MERCURY_THEME override detection', () => {
    expect(detectTerminalTheme({ MERCURY_THEME: 'light' })).toBe('light');
    expect(detectTerminalTheme({ MERCURY_THEME: 'Dark', COLORFGBG: '0;15' })).toBe('dark');
    expect(detectTerminalTheme({ MERCURY_THEME: 'auto', COLORFGBG: '0;15' })).toBe('light');
  });
});
