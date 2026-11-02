import { SLASH_COMMANDS } from './slash-list.js';
import { CHAT_COMMAND_HELP } from '../../utils/manual.js';

/**
 * The "/" picker's catalog: every slash command a surface can offer, with
 * what it does. The commands are the canonical list (the terminal's), the
 * descriptions are the manual's, and plugins add their own commands.
 */
export interface CommandEntry {
  /** What the picker inserts, e.g. "/bots create " (a trailing space: it takes an argument). */
  command: string;
  /** How it reads, e.g. "/bots create <id> <name>". */
  usage: string;
  description: string;
  takesArgument: boolean;
  source: 'mercury' | 'plugin';
  /** The plugin that adds it. */
  plugin?: string;
}

/** "/models use <provider>" → "/models use": the words before the first argument or choice. */
function keyOf(usage: string): string {
  const words: string[] = [];
  for (const w of usage.trim().split(/\s+/)) {
    if (/[<[|]/.test(w)) break;
    words.push(w);
  }
  return words.join(' ');
}

export function commandCatalog(pluginCommands: Array<{ name: string; description: string; plugin: string }> = []): CommandEntry[] {
  const help = new Map<string, { usage: string; description: string }>();
  for (const [usage, description] of CHAT_COMMAND_HELP) {
    const key = keyOf(usage);
    if (key.startsWith('/') && !help.has(key)) help.set(key, { usage, description });
  }
  const describe = (command: string) => {
    const words = command.trim().split(/\s+/);
    // The command itself, else its nearest documented parent ("/session archive" → "/session").
    for (let n = words.length; n > 0; n--) {
      const hit = help.get(words.slice(0, n).join(' '));
      if (hit) return n === words.length ? hit : { usage: command.trim(), description: hit.description };
    }
    return { usage: command.trim(), description: '' };
  };
  const out: CommandEntry[] = SLASH_COMMANDS.map((command) => {
    const d = describe(command);
    return { command, usage: d.usage, description: d.description, takesArgument: command.endsWith(' '), source: 'mercury' as const };
  });
  const seen = new Set(out.map((c) => c.command.trim()));
  for (const p of pluginCommands) {
    const command = `/${p.name}`;
    if (seen.has(command)) continue;
    seen.add(command);
    out.push({ command: `${command} `, usage: `${command} …`, description: p.description, takesArgument: true, source: 'plugin', plugin: p.plugin });
  }
  return out;
}
