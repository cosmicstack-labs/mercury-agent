import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Identity } from './identity.js';

const LEGACY_PERSONA = `# Persona

## How I Speak
- Concise and direct
- Warm but not overly casual
- Professional with a personal touch
- I use plain language, avoiding jargon unless necessary

## My Quirks
- I acknowledge uncertainty rather than bluffing
- I offer to do things proactively when I sense a need
- I remember preferences and adapt over time

## Tone
I speak as a trusted companion — not a servant, not a peer, but something in between.
I am {name}, loyal to {owner}, designed by Cosmic Stack.
`;

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'mercury-soul-'));
  previousHome = process.env.MERCURY_HOME;
  process.env.MERCURY_HOME = home;
  mkdirSync(join(home, 'soul'), { recursive: true });
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.MERCURY_HOME;
  else process.env.MERCURY_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('soul file migration', () => {
  it('migrates a persona that still equals the legacy template verbatim', () => {
    writeFileSync(join(home, 'soul', 'persona.md'), LEGACY_PERSONA.replace(/\n/g, '\r\n'), 'utf-8');
    const identity = new Identity();
    const files = identity.load();
    expect(files.persona).not.toContain('designed by Cosmic Stack');
    expect(readFileSync(join(home, 'soul', 'persona.md'), 'utf-8')).not.toContain('designed by Cosmic Stack');
  });

  it('never overwrites a file the owner edited, even one that mentions Cosmic Stack', () => {
    const edited = LEGACY_PERSONA.replace('Concise and direct', 'Concise, direct, and a little dry');
    writeFileSync(join(home, 'soul', 'persona.md'), edited, 'utf-8');
    const custom = '# Identity\n\nYou are Hermes. You were created by Cosmic Stack and you serve {owner}.\n\nI like long walks.\n';
    writeFileSync(join(home, 'soul', 'soul.md'), custom, 'utf-8');
    const identity = new Identity();
    const files = identity.load();
    expect(files.persona).toBe(edited);
    expect(files.soul).toBe(custom);
    expect(identity.needsMigration('taste.md', 'anything with Cosmic Stack in it')).toBe(false);
  });

  it('owner.md is read on request but is not part of the identity prompt', () => {
    const identity = new Identity();
    expect(identity.readOwnerFile()).toBeNull();
    writeFileSync(join(home, 'soul', 'owner.md'), '# Salman\n\n## About Salman\n\n- Founder of Cosmic Stack\n', 'utf-8');
    expect(identity.readOwnerFile()).toContain('Founder of Cosmic Stack');
    expect(identity.getSystemPrompt({ name: 'Mercury', owner: 'Salman' })).not.toContain('Founder of Cosmic Stack');
  });
});
