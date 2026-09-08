import { describe, expect, it } from 'vitest';
import React, { useEffect, useState } from 'react';
import { render } from 'ink';
import { Text, Static } from 'ink';
import { EventEmitter } from 'node:events';

/**
 * Functional reproduction of the duplicate-transcript bug: a <Static> item
 * must be written to the terminal EXACTLY ONCE. The first itemKey patch
 * committed keys but left the rendered children mounted — ink's renderer
 * recomputes static output from mounted children on EVERY render and
 * re-printed them (user-visible: the last transcript message duplicating
 * every ~30s render cycle).
 */
class FakeStdout extends EventEmitter {
  chunks: string[] = [];
  columns = 80;
  rows = 24;
  isTTY = true;
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get output(): string {
    return this.chunks.join('');
  }
}

class FakeStdin extends EventEmitter {
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  isTTY = false;
}

// Module-level identity, exactly like App.tsx's `staticItemKey` — an inline
// arrow would get a new identity every render, re-running the dedup memo and
// masking the bug this test guards against.
const stableItemKey = (item: string) => item;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function TestApp({ onDone }: { onDone: () => void }) {
  const [msgs, setMsgs] = useState<string[]>(['m1']);
  const [, setTick] = useState(0);
  useEffect(() => {
    void (async () => {
      await sleep(60);
      setMsgs(['m1', 'm2']);
      // Heartbeat-like rerenders that add NO new static items — the exact
      // conditions under which the bug duplicated the last transcript item.
      for (let i = 0; i < 4; i++) {
        await sleep(60);
        setTick((t) => t + 1);
      }
      onDone();
    })();
  }, []);
  return (
    <Static items={msgs} itemKey={stableItemKey}>
      {(item) => <Text key={item}>{item}</Text>}
    </Static>
  );
}

describe('ink Static writes each item exactly once', () => {
  it('does not re-print committed items on later rerenders', async () => {
    const stdout = new FakeStdout();
    let unmount: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      const instance = render(<TestApp onDone={() => resolve()} />, {
        stdout: stdout as unknown as NodeJS.WriteStream,
        stdin: new FakeStdin() as unknown as NodeJS.ReadStream,
        exitOnCtrlC: false,
        patchConsole: false,
      });
      unmount = () => instance.unmount();
    });
    await done;
    unmount();
    const occurrences = stdout.output.split('m2').length - 1;
    expect(occurrences, `m2 must be written once, got ${occurrences}`).toBe(1);
  }, 10_000);
});