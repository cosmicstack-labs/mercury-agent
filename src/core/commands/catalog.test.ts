import { describe, expect, it } from 'vitest';
import { commandCatalog } from './catalog.js';
import { SLASH_COMMANDS } from './slash-list.js';

/** The desktop's "/" picker offers every command the terminal does, with the manual's words. */
describe('command catalog', () => {
  const catalog = commandCatalog();
  const find = (cmd: string) => catalog.find((c) => c.command === cmd);

  it('has every canonical command, in order, marking the ones that take an argument', () => {
    expect(catalog.map((c) => c.command)).toEqual([...SLASH_COMMANDS]);
    expect(find('/bots create ')?.takesArgument).toBe(true);
    expect(find('/help')?.takesArgument).toBe(false);
  });

  it('describes commands from the manual, by their words before any argument', () => {
    expect(find('/help')?.description).toBe('Show this manual');
    expect(find('/models use ')).toMatchObject({ usage: '/models use <provider>' });
    expect(find('/models use ')?.description).toBeTruthy();
    // Most commands are documented; an undocumented one still appears, without words.
    const described = catalog.filter((c) => c.description).length;
    expect(described / catalog.length).toBeGreaterThan(0.6);
  });

  it('adds the commands running plugins contribute, once, after Mercury\'s own', () => {
    const withPlugins = commandCatalog([{ name: 'weather', description: 'Forecast for a city', plugin: 'Weather' }, { name: 'help', description: 'shadow', plugin: 'Bad' }]);
    expect(withPlugins.at(-1)).toMatchObject({ command: '/weather ', description: 'Forecast for a city', source: 'plugin', plugin: 'Weather' });
    expect(withPlugins.filter((c) => c.command.trim() === '/help')).toHaveLength(1);
  });
});
