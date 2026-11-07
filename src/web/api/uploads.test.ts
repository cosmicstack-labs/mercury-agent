import { describe, expect, it, vi } from 'vitest';

// Fixed home: attachments land under MERCURY_HOME/uploads.
await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.MERCURY_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-uploads-'));
});

const { storeInlineAttachments, uploadsDir, MAX_IMAGE_BYTES } = await import('./uploads.js');
const { withAttachments } = await import('../../core/attachments.js');
const { existsSync, readFileSync, statSync } = await import('node:fs');
const { sep } = await import('node:path');

/** Windows joins with \\; assertions stay portable by comparing posix-style. */
const posix = (value: string) => value.split(sep).join('/');

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

describe('storeInlineAttachments', () => {
  it('writes a png under uploads/<yyyy-mm>/ and returns a runtime attachment', () => {
    const result = storeInlineAttachments([{ name: 'My photo.png', data: PNG.toString('base64') }], new Date('2026-03-09T10:00:00Z'));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [attachment] = result.attachments;
    expect(attachment.kind).toBe('image');
    expect(attachment.mime).toBe('image/png');
    expect(attachment.name).toBe('My photo.png');
    const expectedDir = posix(uploadsDir(new Date('2026-03-09T10:00:00Z')));
    expect(posix(attachment.path).startsWith(`${expectedDir}/`)).toBe(true);
    expect(existsSync(attachment.path)).toBe(true);
    expect(statSync(attachment.path).size).toBe(PNG.length);
    // POSIX mode: Windows ignores it (NTFS ACLs), so the assertion is POSIX-only.
    if (process.platform !== 'win32') expect(statSync(attachment.path).mode & 0o777).toBe(0o600);
  });

  it('accepts a data: URL prefix', () => {
    const result = storeInlineAttachments([{ data: `data:image/png;base64,${PNG.toString('base64')}` }]);
    expect(result.ok).toBe(true);
  });

  it('trusts the bytes, not the declared mime: a png labelled as pdf stays a png', () => {
    const result = storeInlineAttachments([{ mime: 'application/pdf', data: PNG.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].kind).toBe('image');
    expect(result.attachments[0].mime).toBe('image/png');
  });

  it('keeps a pdf a document', () => {
    const result = storeInlineAttachments([{ name: 'brief.pdf', data: PDF.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].kind).toBe('document');
    expect(result.attachments[0].mime).toBe('application/pdf');
  });

  it('never writes outside uploads, whatever the client calls the file', () => {
    const result = storeInlineAttachments([{ name: '../../etc/passwd.png', data: PNG.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].name).toBe('passwd.png');
    expect(result.attachments[0].path.includes('..')).toBe(false);
    expect(result.attachments[0].path.startsWith(uploadsDir())).toBe(true);
  });

  it('names an unnamed file from its detected type', () => {
    const result = storeInlineAttachments([{ data: PNG.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attachments[0].name).toMatch(/\.png$/);
  });

  it('rejects formats outside the allowlist even if they contain text', () => {
    const result = storeInlineAttachments([{ name: 'index.html', mime: 'text/plain', data: Buffer.from('hello').toString('base64') }]);
    expect(result).toEqual({ ok: false, error: 'attachment 1 is not a supported image (png, jpeg, webp, gif), PDF, TXT or Markdown file' });
  });

  it.each(['notes.txt', 'notes.MD', 'notes.markdown'])('includes %s for a text-only model with its filename', (name) => {
    const text = '# Notes\nHello, 世界 👋';
    const result = storeInlineAttachments([{ name, data: Buffer.from(text).toString('base64') }]);
    if (!result.ok) throw new Error(result.error);
    expect(result.attachments[0].kind).toBe('document');
    expect(readFileSync(result.attachments[0].path, 'utf8')).toBe(text);
    const message = { id: '1', channelId: 'web', channelType: 'web' as const, senderId: 'owner', content: 'Summarize', timestamp: 0, metadata: { attachments: result.attachments } };
    const out = withAttachments([{ role: 'user', content: 'Summarize' }], message, 'deepseek', 'deepseek-chat');
    const parts = out[0].content as unknown as Array<{ type: string; text: string }>;
    expect(parts[1].type).toBe('text');
    expect(parts[1].text).toContain('untrusted content');
    expect(JSON.parse(parts[1].text.split('\n').slice(1).join('\n'))).toEqual({ name, text });
  });

  it('accepts empty text and UTF-8 BOMs, including an unnamed text upload', () => {
    for (const text of ['', '\ufeffhello']) {
      const result = storeInlineAttachments([{ mime: 'text/plain; charset=utf-8', data: Buffer.from(text).toString('base64') }]);
      if (!result.ok) throw new Error(result.error);
      expect(result.attachments[0].name).toMatch(/\.txt$/);
    }
  });

  it('rejects malformed UTF-8, binary controls, malformed base64 and non-string metadata', () => {
    for (const bytes of [Buffer.from([0xc3, 0x28]), Buffer.from('binary\0data'), Buffer.from('utf16', 'utf16le')]) {
      expect(storeInlineAttachments([{ name: 'notes.txt', data: bytes.toString('base64') }])).toMatchObject({ ok: false, error: expect.stringContaining('UTF-8') });
    }
    expect(storeInlineAttachments([{ name: 'notes.txt', data: 'aGVsbG8=!!' }])).toMatchObject({ ok: false, error: expect.stringContaining('base64') });
    expect(storeInlineAttachments([{ name: 123, data: 'aGVsbG8=' }])).toMatchObject({ ok: false, error: expect.stringContaining('strings') });
  });

  it('enforces the text byte cap', () => {
    const result = storeInlineAttachments([{ name: 'large.txt', data: Buffer.alloc(256 * 1024 + 1, 'a').toString('base64') }]);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('256 KiB') });
  });

  it('rejects an image over the model limit', () => {
    const huge = Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]);
    const result = storeInlineAttachments([{ data: huge.toString('base64') }]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('the limit is 8 MB');
  });

  it('rejects more than four files, a non-array, and missing data', () => {
    expect(storeInlineAttachments(Array.from({ length: 5 }, () => ({ data: PNG.toString('base64') })))).toEqual({
      ok: false,
      error: 'at most 4 attachments per message',
    });
    expect(storeInlineAttachments('nope')).toEqual({ ok: false, error: 'attachments must be an array' });
    expect(storeInlineAttachments([{ name: 'x.png' }])).toEqual({ ok: false, error: 'attachment 1 needs base64 "data"' });
  });

  it('treats absent attachments as none', () => {
    expect(storeInlineAttachments(undefined)).toEqual({ ok: true, attachments: [] });
    expect(storeInlineAttachments([])).toEqual({ ok: true, attachments: [] });
  });

  it('round-trips the bytes exactly', () => {
    const result = storeInlineAttachments([{ data: PNG.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(readFileSync(result.attachments[0].path).equals(PNG)).toBe(true);
  });

  it('feeds the runtime: a stored png becomes an image part for a vision model', () => {
    const result = storeInlineAttachments([{ name: 'dot.png', data: PNG.toString('base64') }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const message = {
      id: 'm1',
      channelId: 'sess-1',
      channelType: 'web' as const,
      senderId: 'web_user',
      content: 'What is this?',
      timestamp: Date.now(),
      metadata: { attachments: result.attachments },
    };
    const history = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: 'What is this?' },
    ];

    const withVision = withAttachments(history, message, 'openai', 'gpt-4.1-mini') as Array<{ content: unknown }>;
    const parts = withVision[1].content as Array<{ type: string; mediaType?: string }>;
    expect(Array.isArray(parts)).toBe(true);
    expect(parts.some(p => p.type === 'image' && p.mediaType === 'image/png')).toBe(true);

    // A text-only model gets the note instead of the pixels, and the history is untouched.
    const forDeepseek = withAttachments(history, message, 'deepseek', 'deepseek-chat') as Array<{ content: unknown }>;
    expect(JSON.stringify(forDeepseek[1].content)).toContain("can't view images");
    expect(history[1].content).toBe('What is this?');
  });
});
