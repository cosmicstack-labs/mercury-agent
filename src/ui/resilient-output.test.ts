import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { MAX_BACKLOG_BYTES, ResilientTuiOutput } from './resilient-output.js';

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

  it('never drops writes while the terminal is only briefly backpressured', () => {
    // The renderer writes deltas; a dropped write desyncs the screen
    // (regression: a "Processing" block stuck in the transcript).
    let writes = 0;
    const busy = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      isTTY: true,
      writableNeedDrain: true,
      writableLength: 64 * 1024,
      write() {
        writes++;
        return false;
      },
    });
    const resilient = new ResilientTuiOutput(busy as unknown as NodeJS.WriteStream, asWriteStream(new PassThrough()));

    for (let i = 0; i < 100; i++) resilient.write(`frame-${i}`);

    expect(writes).toBe(100);
    resilient.dispose();
  });

  it('sheds writes only past the backlog cap, then repaints once the terminal drains', () => {
    let writes = 0;
    const stalled = Object.assign(new EventEmitter(), {
      columns: 120,
      rows: 40,
      isTTY: true,
      writableNeedDrain: true,
      writableLength: MAX_BACKLOG_BYTES + 1,
      write() {
        writes++;
        return false;
      },
    });
    const resilient = new ResilientTuiOutput(stalled as unknown as NodeJS.WriteStream, asWriteStream(new PassThrough()));
    let repaints = 0;
    resilient.on('resize', () => repaints++);

    for (let i = 0; i < 10_000; i++) resilient.write(`frame-${i}`);
    expect(writes).toBe(0);

    stalled.writableLength = 0;
    stalled.emit('drain');
    expect(repaints).toBe(1);
    resilient.write('after');
    expect(writes).toBe(1);
    resilient.dispose();
  });
});
