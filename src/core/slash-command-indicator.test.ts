import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const agent = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.ts'), 'utf8');

/**
 * A slash command must not light the "Processing" block or start the
 * foreground heartbeat: /memory, /bots, /help… are answered without the
 * model, and some (menus) block inside handleMessage for as long as the
 * user keeps them open. The indicator is raised only when a command falls
 * through to a real model turn.
 */
describe('slash commands do not show the processing indicator', () => {
  it('gates the turn indicator and heartbeat on the message not being a command', () => {
    const head = agent.slice(agent.indexOf('private async handleMessage('), agent.indexOf('const stopHeartbeat ='));
    expect(head).toContain("const isSlashCommand = msg.content.trim().startsWith('/')");
    expect(head).toContain('if (!isSlashCommand) raiseTurnIndicator();');
    expect(agent).toContain('const stopHeartbeat = isSlashCommand ? () => {} : this.startForegroundHeartbeat(msg);');
  });

  it('raises the indicator again right before a fallen-through command reaches the model', () => {
    const idx = agent.indexOf('this.applyExplicitSkillPick(msg, trimmed, messages);');
    expect(idx).toBeGreaterThan(0);
    expect(agent.slice(idx - 200, idx)).toContain('raiseTurnIndicator();');
  });
});
