import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeInlineAttachments, attachmentRefs, resolveUploadRef, uploadRef } from './uploads.js';

// 1×1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Sent files are recorded on their message as refs and served back through
 * /api/chat/uploads/:month/:file. A ref must never reach anything but a
 * stored upload.
 */
describe('stored uploads', () => {
  let home: string;
  const previous = process.env.MERCURY_HOME;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'mercury-uploads-')); process.env.MERCURY_HOME = home; });
  afterEach(() => { if (previous === undefined) delete process.env.MERCURY_HOME; else process.env.MERCURY_HOME = previous; rmSync(home, { recursive: true, force: true }); });

  it('round-trips: stored file → ref → resolved path', () => {
    const upload = storeInlineAttachments([{ name: 'cat.png', data: PNG }], new Date('2026-10-26T00:00:00Z'));
    if (!upload.ok) throw new Error(upload.error);
    const refs = attachmentRefs(upload.attachments);
    expect(refs).toHaveLength(1);
    expect(refs[0].ref).toMatch(/^2026-10\/[0-9a-f-]{36}-cat\.png$/);
    expect(refs[0].kind).toBe('image');
    const [month, file] = refs[0].ref.split('/');
    expect(resolveUploadRef(month, file)).toBeTruthy();
  });

  it('refuses paths outside the uploads folder, traversal and odd names', () => {
    expect(uploadRef('/etc/passwd')).toBeNull();
    expect(resolveUploadRef('..', 'x')).toBeNull();
    expect(resolveUploadRef('2026-10', '../../mercury.yaml')).toBeNull();
    expect(resolveUploadRef('2026-10', 'mercury.yaml')).toBeNull();
    expect(attachmentRefs([{ kind: 'image', path: join(home, 'elsewhere.png') }])).toEqual([]);
  });

  it('refuses a symlink planted in the month folder', () => {
    const dir = join(home, 'uploads', '2026-10');
    mkdirSync(dir, { recursive: true });
    const secret = join(home, 'secret.txt');
    writeFileSync(secret, 'nope');
    const name = '00000000-0000-0000-0000-000000000000-x.png';
    symlinkSync(secret, join(dir, name));
    expect(resolveUploadRef('2026-10', name)).toBeNull();
  });

  it('serves the bytes with their real type, and 404s anything else', async () => {
    const { default: chatRoutes } = await import('./chat.js');
    const upload = storeInlineAttachments([{ name: 'cat.png', data: PNG }]);
    if (!upload.ok) throw new Error(upload.error);
    const [ref] = attachmentRefs(upload.attachments);
    const ok = await chatRoutes.request(`http://127.0.0.1:6174/api/chat/uploads/${ref.ref}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('Content-Type')).toBe('image/png');
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const missing = await chatRoutes.request('http://127.0.0.1:6174/api/chat/uploads/2026-10/00000000-0000-0000-0000-000000000000-none.png');
    expect(missing.status).toBe(404);
  });
});
