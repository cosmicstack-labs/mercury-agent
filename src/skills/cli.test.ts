import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { registerSkillsCommand } from './cli.js';

let root: string;
let work: string;
const previousRoot = process.env.MERCURY_SKILLS_INSTALL_ROOT;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mercury-skills-cli-'));
  work = mkdtempSync(join(tmpdir(), 'mercury-skills-src-'));
  process.env.MERCURY_SKILLS_INSTALL_ROOT = root;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousRoot === undefined) delete process.env.MERCURY_SKILLS_INSTALL_ROOT;
  else process.env.MERCURY_SKILLS_INSTALL_ROOT = previousRoot;
  rmSync(root, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

async function installFrom(body: string): Promise<void> {
  const file = join(work, 'SKILL.md');
  writeFileSync(file, body);
  const program = new Command();
  program.exitOverride();
  registerSkillsCommand(program);
  await program.parseAsync(['skills', 'install', '--from', file], { from: 'user' });
}

describe('mercury skills install --from', () => {
  it('installs a skill with an id under its category, as before', async () => {
    const body = '---\nid: productivity/demo\nname: demo\ndescription: A demo skill\nversion: 1.0.0\n---\n\n# Demo\n';
    await installFrom(body);
    expect(readFileSync(join(root, 'productivity', 'demo', 'SKILL.md'), 'utf-8')).toBe(body);
    expect(existsSync(join(root, 'demo'))).toBe(false);
  });

  it('installs a skill without an id under its name, like /skills install', async () => {
    const body = '---\nname: gws-gmail\ndescription: Gmail through the gws CLI\n---\n\n# Gmail\n';
    await installFrom(body);
    expect(readFileSync(join(root, 'gws-gmail', 'SKILL.md'), 'utf-8')).toBe(body);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('gws-gmail'));
  });

  it('fails on a skill with neither an id nor a name', async () => {
    await expect(installFrom('---\ndescription: No name here\n---\n\n# Nameless\n')).rejects.toThrow('exit 1');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Invalid SKILL.md'));
  });

  it('refuses a name that would leave the skills folder', async () => {
    await expect(installFrom('---\nname: ../escaped-skill\ndescription: Tries to escape\n---\n')).rejects.toThrow('exit 1');
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('outside the skills root'));
    expect(existsSync(join(root, '..', 'escaped-skill'))).toBe(false);
  });
});
