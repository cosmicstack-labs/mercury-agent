import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { ResilientTuiOutput } from './resilient-output.js';

function asWriteStream(stream: Writable): NodeJS.WriteStream {
  return stream as NodeJS.WriteStream;
}

describe('ResilientTuiOutput', () => {
  it('writes to the primary stream normally', async () => {
    const primary = new PassThrough();
    const fallback = new PassThrough();
    let output = '';
    primary.on('data', (chunk) => { output += chunk.toString(); });
    const resilient = new ResilientTuiOutput(asWriteStream(primary), asWriteStream(fallback));

    resilient.write('frame');

    expect(output).toBe('frame');
    expect(resilient.hasFailedOver()).toBe(false);
    resilient.dispose();
  });

  it('fails over instead of crashing when stdout emits EPIPE', () => {
    const primary = new PassThrough();
    const fallback = new PassThrough();
    let output = '';
    fallback.on('data', (chunk) => { output += chunk.toString(); });
    const resilient = new ResilientTuiOutput(asWriteStream(primary), asWriteStream(fallback));

    primary.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    resilient.write('frame');

    expect(resilient.hasFailedOver()).toBe(true);
    expect(output).toContain('Mercury recovered from a terminal output error');
    expect(output).toContain('frame');
    resilient.dispose();
  });

  it('drops animation frames while the terminal is backpressured', () => {
    let writes = 0;
    const stalled = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      isTTY: true,
      writableNeedDrain: true,
      write() {
        writes++;
        return false;
      },
    });
    const fallback = new PassThrough();
    const resilient = new ResilientTuiOutput(stalled as unknown as NodeJS.WriteStream, asWriteStream(fallback));

    for (let i = 0; i < 10_000; i++) resilient.write(`frame-${i}`);

    expect(writes).toBe(0);
    resilient.dispose();
  });
});
