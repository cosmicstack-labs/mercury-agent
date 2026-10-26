import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { modelReadsPdf, modelSeesImages, withAttachments } from './attachments.js';
import type { ChannelMessage } from '../types/channel.js';

const dir = mkdtempSync(join(tmpdir(), 'mercury-att-'));
mkdirSync(dir, { recursive: true });
const img = join(dir, 'image-1.jpg');
const pdf = join(dir, 'document-2.pdf');
writeFileSync(img, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
writeFileSync(pdf, '%PDF-1.4 test');
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const msg = (attachments: unknown[]): ChannelMessage => ({
  id: '1', channelId: 'whatsapp:x', channelType: 'whatsapp', senderId: 'o', content: 'What is it about?', timestamp: 0,
  metadata: { attachments },
});
const history = [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'What is it about?' }];

describe('chat attachments for the model', () => {
  it('a photo goes to a vision model as an image part on the current message only', () => {
    const out = withAttachments(history, msg([{ kind: 'image', path: img }]), 'openai', 'gpt-4.1-mini');
    expect(out[0]).toBe(history[0]);
    const content = out[2].content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: 'text', text: 'What is it about?' });
    expect(content[1]).toMatchObject({ type: 'image', mediaType: 'image/jpeg' });
    expect(Buffer.isBuffer(content[1].image)).toBe(true);
  });

  it('a text-only model gets a note instead of an image it would reject', () => {
    const out = withAttachments(history, msg([{ kind: 'image', path: img }]), 'deepseek', 'deepseek-chat');
    const content = out[2].content as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1);
    expect(String(content[0].text)).toMatch(/can't view images/);
  });

  it('PDFs go to models that read them, and are left as paths otherwise', () => {
    const claude = withAttachments(history, msg([{ kind: 'document', path: pdf }]), 'anthropic', 'claude-sonnet-4-5');
    expect((claude[2].content as unknown as Array<Record<string, unknown>>)[1]).toMatchObject({ type: 'file', mediaType: 'application/pdf', filename: 'document-2.pdf' });
    expect(withAttachments(history, msg([{ kind: 'document', path: pdf }]), 'ollama', 'qwen3:8b')).toBe(history);
  });

  it('no attachments, missing files: unchanged', () => {
    expect(withAttachments(history, msg([]), 'openai', 'gpt-4o')).toBe(history);
    expect(withAttachments(history, msg([{ kind: 'image', path: join(dir, 'gone.jpg') }]), 'openai', 'gpt-4o')).toBe(history);
  });

  it('model capability checks', () => {
    expect(modelSeesImages('openai', 'gpt-4.1-mini')).toBe(true);
    expect(modelSeesImages('anthropic', 'claude-opus-4-1')).toBe(true);
    expect(modelSeesImages('deepseek', 'deepseek-chat')).toBe(false);
    expect(modelSeesImages('ollama', 'llama3.1:8b')).toBe(false);
    expect(modelReadsPdf('openai', 'gpt-5.2-chat-latest')).toBe(true);
    expect(modelReadsPdf('openai', 'gpt-3.5-turbo')).toBe(false);
  });
});
