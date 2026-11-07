import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionRepository } from '../sessions/repository.js';
import { Agent } from './agent.js';

describe('automatic title repair respects user renames', () => {
  let root: string;
  let sessions: SessionRepository;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'mercury-repair-titles-')); sessions = new SessionRepository({ rootDir: root, autoMigrate: false }); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('leaves deterministic voice labels and owner titles unchanged at startup', async () => {
    const voice = sessions.create({ title: 'Voice call · 4:32 PM · 1h 3m', titleSource: 'generated' });
    sessions.appendMessage(voice.id, { role: 'user', content: 'Discuss the trip', metadata: { voiceCall: 'call-1' } });
    const owner = sessions.create({ title: 'This is my chosen title, kept exactly' });
    sessions.appendMessage(owner.id, { role: 'user', content: 'Hi' });
    const ordinary = sessions.create({ title: voice.title, titleSource: 'generated' });
    sessions.appendMessage(ordinary.id, { role: 'user', content: 'A normal chat about a voice call' });
    const generateTitle = vi.fn();
    const agent = Object.assign(Object.create(Agent.prototype), { sessions, generateTitle }) as Agent;
    await expect(agent.repairSessionTitles()).resolves.toEqual({ regenerated: 0, recut: 1 });
    expect(sessions.get(voice.id).title).toBe(voice.title);
    expect(sessions.get(owner.id).title).toBe(owner.title);
    expect(sessions.get(ordinary.id).title).toBe('Voice call · 4:32 PM');
    expect(generateTitle).not.toHaveBeenCalled();
  });

  it('does not overwrite an owner rename made while repair awaited the model', async () => {
    const session = sessions.create({ title: 'I appreciate your request, but cannot help', titleSource: 'generated' });
    sessions.appendMessage(session.id, { role: 'user', content: 'Plan a holiday' });
    sessions.appendMessage(session.id, { role: 'assistant', content: 'Let us plan it' });
    let finish!: (title: string) => void;
    const generated = new Promise<string>(resolve => { finish = resolve; });
    const agent = Object.assign(Object.create(Agent.prototype), { sessions, generateTitle: () => generated }) as Agent;
    const repair = agent.repairSessionTitles();
    sessions.updateTitle(session.id, 'My holiday plan');
    finish('Holiday Planning');
    await repair;
    expect(sessions.get(session.id)).toMatchObject({ title: 'My holiday plan', titleSource: 'user' });
  });
});
