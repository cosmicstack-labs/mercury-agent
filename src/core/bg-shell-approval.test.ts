import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const agentSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'agent.ts'), 'utf8');

/**
 * `/bg <command>` is an alternate shell entry point. It used to call
 * `backgroundTasks.spawnShell()` directly, so an authenticated chat user could
 * bypass Ask-Me approval and run arbitrary OS commands (reported in #73). The
 * contract: the background shell path must run the command through
 * `PermissionManager.checkShellCommand()` before spawning, exactly like the
 * `run_command` tool, and must not spawn when the check denies it.
 */
describe('/bg <command> honors the shell approval boundary', () => {
  it('checks the command before spawning it in the background', () => {
    // The shell branch must call checkShellCommand(command) and bail out when
    // it is not allowed, before reaching spawnShell(command, cwd).
    const shellBranch = agentSrc.match(/const command = args \|\| ''[\s\S]*?spawnShell\(command, cwd\)/s)?.[0] ?? '';
    expect(shellBranch).toContain('checkShellCommand(command)');
    expect(shellBranch).toMatch(/if \(!check\.allowed\)/);
    expect(shellBranch.indexOf('checkShellCommand(command)')).toBeLessThan(shellBranch.indexOf('spawnShell(command, cwd)'));
  });
});
