/* ═══════════════════════════════════════════════════════════════
   The composer's pickers: "/" for commands, "#" for skills — the same
   ones the terminal has. Pure functions; Composer draws and wires them.
   ═══════════════════════════════════════════════════════════════ */

export interface CommandEntry {
  command: string;
  usage: string;
  description: string;
  takesArgument: boolean;
  source: "mercury" | "plugin";
  plugin?: string;
}

export interface SkillEntry {
  name: string;
  description?: string;
  active?: boolean;
}

export type PickerItem =
  | { kind: "command"; key: string; label: string; hint: string; description: string; fill: string; runs: boolean; plugin?: string }
  | { kind: "skill"; key: string; label: string; hint: string; description: string; fill: string; runs: false };

/** "/bots <action> " subcommands whose argument is a bot id. */
const BOT_ARG = /^(\/bots\s+(?:open|send|journal|inbox|budget|edit|delete|enable|disable|stop|start|run|persona|show|folder|fetch|tasks|crew|promote|demote|permissions|export|add-crew|remove-crew)\s+)(\S*)$/i;

/** Which picker the text asks for, if any: a single line starting with "/", or a "#skill" still being typed. */
export function pickerMode(text: string): "command" | "skill" | null {
  if (text.includes("\n")) return null;
  if (text.startsWith("/")) return "command";
  if (/^#[^\s]*$/.test(text)) return "skill";
  return null;
}

/**
 * Commands for what's typed: bot ids when the command takes one, then the
 * commands that start with it, then the ones whose words or description
 * contain it. Exact matches first; at most `limit`.
 */
export function matchCommands(text: string, catalog: readonly CommandEntry[], bots: ReadonlyArray<{ id: string; name: string }> = [], limit = 40): PickerItem[] {
  const out: PickerItem[] = [];
  const arg = BOT_ARG.exec(text);
  if (arg && bots.length) {
    const [, prefix, typed] = arg;
    const p = typed.toLowerCase();
    for (const b of bots.filter((x) => x.id.toLowerCase().startsWith(p) || x.name.toLowerCase().startsWith(p)).slice(0, 8)) {
      out.push({ kind: "command", key: `bot:${b.id}`, label: `${prefix}${b.id}`, hint: "", description: b.name, fill: `${prefix}${b.id} `, runs: false });
    }
  }
  const q = text.toLowerCase();
  const words = q.slice(1).trim();
  const starts = catalog.filter((c) => c.command.toLowerCase().startsWith(q) || c.command.trim().toLowerCase() === q.trim());
  const contains = words
    ? catalog.filter((c) => !starts.includes(c) && (c.command.toLowerCase().includes(words) || c.description.toLowerCase().includes(words)))
    : [];
  for (const c of [...starts, ...contains]) {
    if (out.length >= limit) break;
    const label = c.command.trim();
    out.push({
      kind: "command",
      key: c.command,
      label,
      hint: c.usage.startsWith(label) ? c.usage.slice(label.length).trim() : "",
      description: c.description,
      fill: c.command,
      runs: !c.takesArgument,
      plugin: c.source === "plugin" ? c.plugin : undefined,
    });
  }
  return out;
}

/** Skills for "#…": name prefix, then name contains, then description contains. Active skills only. */
export function matchSkills(text: string, skills: readonly SkillEntry[], limit = 40): PickerItem[] {
  const q = text.slice(1).toLowerCase();
  const usable = skills.filter((s) => s.active !== false);
  const prefix = usable.filter((s) => s.name.toLowerCase().startsWith(q));
  const name = usable.filter((s) => !prefix.includes(s) && s.name.toLowerCase().includes(q));
  const desc = q ? usable.filter((s) => !prefix.includes(s) && !name.includes(s) && (s.description ?? "").toLowerCase().includes(q)) : [];
  return [...prefix, ...name, ...desc].slice(0, limit).map((s) => ({
    kind: "skill" as const, key: s.name, label: `#${s.name}`, hint: "", description: s.description ?? "", fill: `#${s.name} `, runs: false as const,
  }));
}
