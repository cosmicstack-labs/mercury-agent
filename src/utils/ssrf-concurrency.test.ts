import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent as UndiciAgent } from 'undici';

type Address = { address: string; family: number };
type ConnectionLookup = (host: string, options: { all: true }, callback: (error: Error | null, addresses: Address[]) => void) => void;
const lookups = vi.hoisted(() => new WeakMap<object, ConnectionLookup>());

vi.mock('node:dns', () => ({ lookup: vi.fn() }));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return {
    ...actual,
    // PR #286 pairs package fetch with this dispatcher. Defer either fetch
    // entry point; the same real production DNS lookup is still exercised.
    fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
    // Keep the real dispatcher and capture its actual connection lookup.
    // Only the transport response is deferred; production pin handling runs.
    Agent: class extends actual.Agent {
      constructor(options: UndiciAgent.Options) {
        super(options);
        if (typeof options.connect === 'object' && 'lookup' in options.connect && options.connect.lookup) {
          lookups.set(this, options.connect.lookup as ConnectionLookup);
        }
      }
    },
  };
});

import { lookup } from 'node:dns';
import { guardedFetch } from './ssrf.js';

const mockedLookup = vi.mocked(lookup);
const PUBLIC = { address: '93.184.216.34', family: 4 };
const REBOUND = { address: '127.0.0.1', family: 4 };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function answerDns(address: Address): void {
  mockedLookup.mockImplementation(((_host: string, _options: unknown, callback: (error: null, addresses: Address[]) => void) => {
    callback(null, [address]);
  }) as never);
}

function connectionAddress(dispatcher: object): Promise<Address[]> {
  const connectLookup = lookups.get(dispatcher);
  if (!connectLookup) throw new Error('Missing guarded dispatcher lookup');
  return new Promise((resolve, reject) => {
    connectLookup('overlap.example', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  });
}

beforeEach(() => { mockedLookup.mockReset(); });
afterEach(() => vi.unstubAllGlobals());

describe('guardedFetch overlapping DNS pins', () => {
  it.each(['complete', 'fail', 'redirect'] as const)('keeps the validated connection address when a sibling request finishes via %s', async (outcome) => {
    const entered = [deferred<object>(), deferred<object>()];
    const responses = [deferred<Response>(), deferred<Response>()];
    let request = 0;
    vi.stubGlobal('fetch', vi.fn((_url: URL, init: RequestInit & { dispatcher: object }) => {
      const index = request++;
      entered[index].resolve(init.dispatcher);
      return responses[index].promise;
    }));
    answerDns(PUBLIC);
    const first = guardedFetch('https://overlap.example/first', new AbortController().signal);
    await entered[0].promise;
    const second = guardedFetch('https://overlap.example/second', new AbortController().signal);
    const secondDispatcher = await entered[1].promise;
    try {
      // Both requests were validated. A hostile resolver now changes its
      // answer before the second request opens its connection.
      expect(mockedLookup).toHaveBeenCalledTimes(2);
      answerDns(REBOUND);
      if (outcome === 'fail') {
        responses[0].reject(new Error('Transport failed'));
        await expect(first).rejects.toThrow('Transport failed');
      } else if (outcome === 'redirect') {
        responses[0].resolve(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data/' } }));
        await expect(first).rejects.toThrow(/private\/internal/);
      } else {
        responses[0].resolve(new Response('first'));
        expect(await (await first).text()).toBe('first');
      }
      expect(await connectionAddress(secondDispatcher)).toEqual([PUBLIC]);
      expect(mockedLookup).toHaveBeenCalledTimes(2); // no unvalidated DNS fallback
      responses[1].resolve(new Response('second'));
      expect(await (await second).text()).toBe('second');

      // Last release removes the pin rather than retaining stale addresses.
      expect(await connectionAddress(secondDispatcher)).toEqual([REBOUND]);
      expect(mockedLookup).toHaveBeenCalledTimes(3);
    } finally {
      responses[0].resolve(new Response('cleanup'));
      responses[1].resolve(new Response('cleanup'));
      await Promise.allSettled([first, second]);
    }
  });
});
