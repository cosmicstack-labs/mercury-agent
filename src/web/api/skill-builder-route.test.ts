import { describe, expect, it, vi } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.MERCURY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-skill-builder-'));
});

import system, { setSkillBuilder } from './system.js';

const draft = {
  name: 'tidy-downloads',
  description: 'Sorts the Downloads folder into subfolders by file type and removes duplicates.',
  intents: ['tidy my downloads', 'clean up downloads'],
  instructions: '1. Ask which folder (default ~/Downloads).\n2. List the files with list_dir.\n3. Group them by type: images, documents, archives, installers, other.\n4. Move each file into its group folder; never overwrite, add a number instead.\n5. Find exact duplicates by size and hash and ask before deleting any.\n6. Report what moved and what was removed.',
};
const post = (path: string, body: unknown) => system.request(`http://127.0.0.1${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('skill builder routes', () => {
  it('drafts with the default model and the real tool list', async () => {
    const generateText = vi.fn().mockResolvedValue({ text: JSON.stringify({ ...draft, allowedTools: ['list_dir', 'made_up'] }) });
    setSkillBuilder({ provider: () => ({ generateText, getModel: () => 'm' }) as never, tools: () => ['list_dir', 'move_file'] });
    const res = await post('/api/skills/draft', { request: 'tidy my downloads folder by type' });
    const body = (await res.json()) as { draft: { allowedTools: string[] }; problem: string | null };
    expect(res.status).toBe(200);
    expect(body.draft.allowedTools).toEqual(['list_dir']);
    expect(body.problem).toBeNull();
    expect(generateText.mock.calls[0][0]).toContain('list_dir, move_file');
  });

  it('refuses a description that says too little, and an unsaveable draft', async () => {
    expect((await post('/api/skills/draft', { request: 'help' })).status).toBe(400);
    expect((await post('/api/skills/self-made', { draft: { ...draft, instructions: 'tidy it' } })).status).toBe(400);
  });

  it('saves a reviewed draft as a self-made skill that shows up in the list', async () => {
    const res = await post('/api/skills/self-made', { draft });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'tidy-downloads' });
    const list = (await (await system.request('http://127.0.0.1/api/skills')).json()) as { skills: Array<{ name: string; selfMade: boolean }> };
    expect(list.skills.find((s) => s.name === 'tidy-downloads')?.selfMade).toBe(true);
  });
});
