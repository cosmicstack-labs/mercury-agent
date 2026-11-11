/**
 * Untrusted content that arrives with the message itself (ADR-044): a file
 * attached to it (its text goes to the model), or the message being from
 * someone other than the owner (a group member, a WhatsApp contact).
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { ChannelMessage } from '../types/channel.js';
import { scanForInjection } from './injection-scan.js';
import { noteExposure } from './provenance.js';

const SCAN_BYTES = 256 * 1024;

function head(path: string): string {
  try {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(Math.min(size, SCAN_BYTES));
      readSync(fd, buf, 0, buf.length, 0);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch {
    return '';
  }
}

export function noteMessageExposure(msg: ChannelMessage): void {
  if (msg.channelType === 'internal') return;
  if (msg.senderRole === 'member') {
    noteExposure({ label: `a message from ${msg.senderName ?? 'someone'} (not the owner)` });
  }
  const files = Array.isArray(msg.metadata?.attachments) ? (msg.metadata.attachments as Array<{ kind?: string; path?: string; name?: string }>) : [];
  for (const f of files) {
    // Photos are seen, not read as text; documents and text files are.
    if (!f?.path || f.kind === 'image' || f.kind === 'voice' || f.kind === 'audio') continue;
    const scan = scanForInjection(head(f.path));
    noteExposure({ label: `attached file ${f.name ?? basename(f.path)}`, ...(scan.suspicious ? { findings: scan.findings } : {}) });
  }
}
