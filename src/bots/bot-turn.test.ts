import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock only streamText; stepCountIs must stay real so the turn loop's
// per-round step budget still applies. The mock must drive onStepFinish
// itself (that is the AI-SDK callback that decrements the budget) and
// return the streamText result shape: fullStream + final text/finishReason
// promises. runBotTurn consumes the deltas as live 'thinking' activity.
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: vi.fn(),
  };
});

import { streamText } from 'ai';
import { runBotTurn, classifyFailure, type BotActivityEvent, type BotTurnInput } from './bot-turn.js';
import { MAX_AUTOMATIC_CONTINUATIONS } from '../core/execution-limits.js';

const mockedStreamText = vi.mocked(streamText);

/** streamText-shaped result: async fullStream + final promise fields. */
function streamedResult(opts: { fullStream?: any[]; text: string; finishReason: string; stream?: (opts: any) => any } = { text: '', finishReason: 'stop' }) {
  return {
    fullStream: (async function* () {
      for (const part of opts.fullStream ?? []) {
        if (part.type === '__sleep__') {
          await new Promise((resolve) => setTimeout(resolve, part.ms ?? 350));
          continue;
        }
        yield part;
      }
    })(),
    text: Promise.resolve(opts.text),
    finishReason: Promise.resolve(opts.finishReason),
    usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
  } as any;
}

function turnInput(overrides: Record<string, unknown> = {}): Parameters<typeof runBotTurn>[0] {
  return {
    manifest: {
      id: 'tester',
      name: 'Tester',
      enabled: true,
      autonomy: { maxSteps: 2 },
    } as any,
    trigger: 'chat',
    prompt: 'do the work',
    persona: 'test persona',
    mail: [],
    pollMail: () => [],
    sandbox: { workspace: '/tmp/ws', shared: '/tmp/shared' },
    capabilities: {} as any,
    tools: {},
    userMemory: null,
    provider: {
      name: 'stub',
      getModel: () => 'stub-model',
      getModelInstance: () => ({}),
    } as any,
    tokenBudget: { recordUsage: () => {}, getRemaining: () => 100000 } as any,
    abortSignal: new AbortController().signal,
    ...overrides,
  } as any;
}

beforeEach(() => {
  mockedStreamText.mockReset();
});

describe('runBotTurn step-budget continuation', () => {
  it('continues in-process with a fresh budget instead of pausing, preserving the conversation', async () => {
    // Round 1: burns the 2-step budget with tool calls still pending.
    // Round 2: finishes with text.
    mockedStreamText
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [{ toolName: 'fs_write' }] });
        return streamedResult({ text: '', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 4 } } as any);
      })
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 5, outputTokens: 2 }, toolCalls: [] });
        return streamedResult({ text: 'all done', finishReason: 'stop', usage: { inputTokens: 5, outputTokens: 2 } } as any);
      });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('completed');
    expect(output.output).toBe('all done');
    expect(mockedStreamText).toHaveBeenCalledTimes(2);
    // Tool usage from the pre-refill round is still attributed.
    expect(output.toolsUsed).toEqual(['fs_write']);
    expect(output.tokensIn).toBe(15);

    // The resume nudge carries the SAME conversation forward (messages grow,
    // not rebuild) and tells the model not to re-wrap the task.
    const secondCall = mockedStreamText.mock.calls[1][0] as any;
    const nudges = secondCall.messages.filter((m: any) => String(m.content).includes('[SYSTEM: STEP BUDGET]'));
    expect(nudges).toHaveLength(1);
  });

  it('stays bounded: past the continuation bound it returns paused with step_budget', async () => {
    mockedStreamText.mockImplementation((opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
      return streamedResult({ text: '', finishReason: 'tool-calls', usage: { inputTokens: 2, outputTokens: 2 } } as any);
    });

    const output = await runBotTurn(turnInput());

    expect(output.status).toBe('paused');
    expect(output.reasonCode).toBe('step_budget');
    // Initial budget + one refill per continuation round.
    expect(mockedStreamText).toHaveBeenCalledTimes(MAX_AUTOMATIC_CONTINUATIONS + 1);
  });

  it('network blips classify as transient (retryable), not unknown_error', () => {
    // The live failure that shipped a lead bot to the DLQ with a needs-you
    // flag: "Cannot connect to API: read ECONNRESET" — a plain connection
    // drop that fell through every transient pattern.
    expect(classifyFailure(new Error('Cannot connect to API: read ECONNRESET'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('getaddrinfo ENOTFOUND api.example.com'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('fetch failed: ECONNREFUSED 1.2.3.4:443'))).toBe('provider_timeout');
    // "The operation timed out." (with a SPACE) is how several providers
    // phrase a deadline miss — it used to fall through to unknown_error and
    // ship long leader-bot turns straight to the DLQ instead of retrying.
    expect(classifyFailure(new Error('The operation timed out.'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('Request timed out after 60000ms'))).toBe('provider_timeout');
    // Still-permanent things stay permanent.
    expect(classifyFailure(new Error('401 unauthorized'))).toBe('provider_auth');
    expect(classifyFailure(new Error('permission denied by policy'))).toBe('permission_denied');
  });

  it('an aborted turn during continuation still reports halted, not paused', async () => {
    const controller = new AbortController();
    mockedStreamText
      .mockImplementationOnce((opts: any) => {
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
        return streamedResult({ text: '', finishReason: 'tool-calls' } as any);
      })
      .mockImplementationOnce(() => {
        controller.abort();
        throw new Error('Request was aborted');
      });

    const output = await runBotTurn(turnInput({ abortSignal: controller.signal }));

    expect(output.status).toBe('halted');
  });
});
describe('runBotTurn live thinking events', () => {
  const activityEvents: any[] = [];
  function inputWithActivity(overrides: Record<string, unknown> = {}): Parameters<typeof runBotTurn>[0] {
    activityEvents.length = 0;
    return turnInput({ onActivity: (ev: BotActivityEvent) => activityEvents.push(ev), ...overrides });
  }

  it('emits cumulative reasoning/text tails at throttle boundaries and a final flush', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'final reply text',
        finishReason: 'stop',
        fullStream: [
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'reasoning-delta', id: 'r', text: 'I should check the prices' },
          { type: 'reasoning-delta', id: 'r', text: ' then plan the write' },
          { type: '__sleep__', ms: 350 }, // crosses the 300ms throttle boundary
          { type: 'reasoning-delta', id: 'r', text: ' and now act' },
          { type: 'text-delta', id: 't', text: 'partial reply' },
          { type: 'text-delta', id: 't', text: ' more' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());

    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    // At least the crossed-throttle boundary emission + the final flush.
    expect(thinking.length).toBeGreaterThanOrEqual(2);
    const last = thinking.at(-1);
    expect(last.reasoningTail).toContain('I should check the prices');
    expect(last.reasoningTail).toContain('and now act');
    expect(last.textTail).toBe('partial reply more');
  });

  it('inserts a paragraph break at step boundaries so step narrations do not run together', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'done',
        finishReason: 'stop',
        fullStream: [
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'text-delta', id: 't', text: 'first step narration' },
          { type: 'start-step', request: {}, warnings: [] },
          { type: 'text-delta', id: 't', text: 'second step narration' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());
    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    const lastTextTail = thinking.at(-1).textTail;
    expect(lastTextTail).toContain('first step narration');
    expect(lastTextTail).toContain('second step narration');
    expect(lastTextTail).toContain('\n\n');
  });

  it('providers without reasoning produce text tails only', async () => {
    mockedStreamText.mockImplementationOnce((opts: any) =>
      streamedResult({
        text: 'reply',
        finishReason: 'stop',
        fullStream: [
          { type: 'text-delta', id: 't', text: 'reply streaming' },
        ],
      }),
    );
    const output = await runBotTurn(inputWithActivity());
    expect(output.status).toBe('completed');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    expect(thinking.at(-1).textTail).toBe('reply streaming');
    expect(thinking.at(-1).reasoningTail).toBe('');
  });

  it('tails restart with each turn round (a new generation thinks anew)', async () => {
    let round = 0;
    mockedStreamText.mockImplementation((opts: any) => {
      round++;
      if (round === 1) {
        opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{ toolName: 'fs_write' }] });
        return streamedResult({ text: '', finishReason: 'tool-calls', fullStream: [{ type: 'text-delta', id: 't', text: 'round one thoughts' }] });
      }
      opts.onStepFinish?.({ usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [] });
      return streamedResult({ text: 'ok', finishReason: 'stop', fullStream: [{ type: 'text-delta', id: 't', text: 'round two thoughts' }] });
    });
    const output = await runBotTurn(inputWithActivity({ manifest: { id: 't', name: 'T', enabled: true, autonomy: { maxSteps: 1 } } as any }));
    expect(output.output).toBe('ok');
    const thinking = activityEvents.filter((e) => e.kind === 'thinking');
    const firstRound = thinking.filter((e) => e.textTail.includes('round one'));
    const secondRound = thinking.filter((e) => e.textTail.includes('round two') && !e.textTail.includes('round one'));
    expect(firstRound.length).toBeGreaterThan(0);
    expect(secondRound.length).toBeGreaterThan(0);
  });
});

// ── ADR-020: governor, compaction, failure classes, outcome gate ──────────

import { compactMessages, computeOutcome, wrapBotTools, isReadOnlyCommand, isTransientFailure, DEFAULT_TURN_LIMITS } from './bot-turn.js';

describe('classifyFailure (ADR-020)', () => {
  it('treats network cuts and empty streams as transient, unwrapping retry wrappers', () => {
    expect(classifyFailure(new Error('terminated'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('The socket connection was closed unexpectedly'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('Generation was interrupted before completion (no finish signal from provider)'))).toBe('provider_timeout');
    expect(classifyFailure(new Error('No output generated. Check the stream for errors.'))).toBe('provider_empty');
    expect(classifyFailure(new Error('Failed after 3 attempts. Last error: Too many requests'))).toBe('provider_rate_limit');
    expect(classifyFailure(new Error('Failed after 3 attempts. Last error: Internal server error'))).toBe('unknown_error');
    expect(classifyFailure(new Error('No LLM providers available — configure ANTHROPIC_API_KEY'))).toBe('provider_unavailable');
    for (const code of ['provider_timeout', 'provider_empty', 'provider_rate_limit']) expect(isTransientFailure(code)).toBe(true);
    expect(isTransientFailure('provider_unavailable')).toBe(false);
  });

  it('surfaces the stream error instead of the generic "No output generated"', async () => {
    mockedStreamText.mockImplementationOnce(() => ({
      fullStream: (async function* () { yield { type: 'error', error: new Error('invalid_api_key: 401') }; })(),
      text: Promise.reject(new Error('No output generated. Check the stream for errors.')),
      finishReason: Promise.reject(new Error('No output generated. Check the stream for errors.')),
      usage: Promise.resolve({}),
    }) as any);
    const out = await runBotTurn(turnInput());
    expect(out.status).toBe('failed');
    expect(out.error).toContain('invalid_api_key');
    expect(out.reasonCode).toBe('provider_auth');
  });
});

describe('compactMessages', () => {
  const toolMsg = (id: string, value: string) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'read_file', output: { type: 'text', value } }] });
  it('keeps the newest results (capped) and stubs older ones', () => {
    const big = 'x'.repeat(30_000);
    const msgs = [
      { role: 'user', content: 'go' },
      toolMsg('a', 'old '.repeat(300)),
      toolMsg('b', big),
      toolMsg('c', 'recent'),
    ];
    const out: any[] = compactMessages(msgs, { keepRecentToolResults: 2, maxToolResultChars: 1000 });
    expect(out[0]).toBe(msgs[0]);
    expect(out[1].content[0].output.value).toContain('more chars trimmed from an earlier step');
    expect(out[1].content[0].output.value.length).toBeLessThan(600);
    expect(out[2].content[0].output.value).toContain('[…truncated');
    expect(out[2].content[0].output.value.length).toBeLessThan(1100);
    expect(out[3].content[0].output.value).toBe('recent');
    // Never mutates the originals.
    expect((msgs[2] as any).content[0].output.value).toBe(big);
  });
  it('is a no-op without tool results', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    expect(compactMessages(msgs, DEFAULT_TURN_LIMITS)).toBe(msgs);
  });
});

describe('turn governor', () => {
  it('stops a turn that exceeds the per-turn token cap and reports it as turn_budget, not an escalation', async () => {
    let rounds = 0;
    mockedStreamText.mockImplementation((opts: any) => {
      rounds++;
      // Each step burns 200k tokens; the cap is 300k.
      opts.onStepFinish?.({ usage: { inputTokens: 200_000, outputTokens: 10 }, toolCalls: [{ toolName: 'read_file', toolCallId: 't1', input: { path: 'a' } }], toolResults: [{ toolCallId: 't1', output: { type: 'text', value: 'ok' } }] });
      opts.onStepFinish?.({ usage: { inputTokens: 200_000, outputTokens: 10 }, toolCalls: [], toolResults: [] });
      const aborted = opts.abortSignal?.aborted;
      return streamedResult({ text: aborted ? '' : 'still going', finishReason: aborted ? 'other' : 'tool-calls' } as any);
    });
    const out = await runBotTurn(turnInput({ trigger: 'cron', manifest: { id: 't', name: 'T', enabled: true, autonomy: { maxSteps: 2 } } }));
    expect(out.status).toBe('failed');
    expect(out.reasonCode).toBe('turn_budget');
    expect(out.tokensIn).toBeGreaterThanOrEqual(300_000);
    expect(rounds).toBe(1);
    expect(out.output).toContain('300k-token cap');
  });

  it('honours a per-bot maxTokensPerTurn override', async () => {
    mockedStreamText.mockImplementation((opts: any) => {
      opts.onStepFinish?.({ usage: { inputTokens: 900, outputTokens: 10 }, toolCalls: [], toolResults: [] });
      return streamedResult({ text: 'done', finishReason: 'stop' } as any);
    });
    const out = await runBotTurn(turnInput({ manifest: { id: 't', name: 'T', enabled: true, autonomy: { maxSteps: 3, maxTokensPerTurn: 500 } } }));
    expect(out.reasonCode).toBe('turn_budget');
  });
});

describe('outcome gate', () => {
  const sandbox = { workspace: '/tmp/ws', shared: '/tmp/shared' };
  it('classifies the trace: notes are none, outside writes and commands are actions, deliveries win', () => {
    const ok = (name: string, arg?: string, task?: boolean) => ({ name, ok: true, arg, ...(task ? { task } : {}) });
    expect(computeOutcome({ trace: [ok('read_file', '/x'), ok('write_file', '/tmp/shared/record.md')], deliveries: [], expects: 'work', text: 'Filed the record.', sandbox })).toBe('none');
    expect(computeOutcome({ trace: [ok('write_file', '/home/u/site/index.html')], deliveries: [], expects: 'work', text: '', sandbox })).toBe('action');
    expect(computeOutcome({ trace: [ok('run_command', 'ls -la && cmp a b')], deliveries: [], expects: 'work', text: '', sandbox })).toBe('none');
    expect(computeOutcome({ trace: [ok('run_command', 'npm run build')], deliveries: [], expects: 'work', text: '', sandbox })).toBe('action');
    expect(computeOutcome({ trace: [{ name: 'run_command', ok: false, arg: 'npm run build' }], deliveries: [], expects: 'work', text: '', sandbox })).toBe('none');
    expect(computeOutcome({ trace: [ok('bot_send', 'crew-1', true)], deliveries: [], expects: 'work', text: '', sandbox })).toBe('delegated');
    expect(computeOutcome({ trace: [], deliveries: ['/home/u/Documents/Mercury/Writer/2026-10-10 Piece.md'], expects: 'work', text: '', sandbox })).toBe('deliverable');
    expect(computeOutcome({ trace: [], deliveries: [], expects: 'message', text: 'Here is my report.', sandbox })).toBe('message');
    expect(computeOutcome({ trace: [], deliveries: [], expects: 'message', text: '   ', sandbox })).toBe('none');
    expect(isReadOnlyCommand('cat a | grep b')).toBe(true);
    expect(isReadOnlyCommand('cat a | tee b')).toBe(false);
  });

  it('nudges a work run that only wrote notes exactly once, then journals none + the false claim', async () => {
    const prompts: string[] = [];
    mockedStreamText.mockImplementation((opts: any) => {
      prompts.push(opts.messages.at(-1).content);
      opts.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ toolName: 'write_file', toolCallId: 'w', input: { path: '/tmp/shared/cycle-record.md', content: 'x' } }], toolResults: [{ toolCallId: 'w', output: { type: 'text', value: 'Wrote file' } }] });
      return streamedResult({ text: 'Record filed and delivered.', finishReason: 'stop' } as any);
    });
    const out = await runBotTurn(turnInput({ trigger: 'cron', manifest: { id: 't', name: 'T', enabled: true, autonomy: { maxSteps: 3 } } }));
    expect(out.status).toBe('completed');
    expect(out.outcome).toBe('none');
    expect(out.outcomeNudged).toBe(true);
    expect(out.claimedWithoutAction).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('[outcome check]');
    expect(out.toolCalls).toBe(2);
    expect(out.steps).toBe(0); // the mock never fires onStepStart
  });

  it('does not nudge a check routine or a reply-contract run', async () => {
    mockedStreamText.mockImplementation(() => streamedResult({ text: 'All quiet.', finishReason: 'stop' } as any));
    const check = await runBotTurn(turnInput({ trigger: 'cron', expects: 'check' }));
    expect(check.outcome).toBe('none');
    expect(check.outcomeNudged).toBe(false);
    const reply = await runBotTurn(turnInput({ trigger: 'chat' }));
    expect(reply.outcome).toBe('message');
    expect(mockedStreamText).toHaveBeenCalledTimes(2);
  });

  it('a delivery during the turn makes the outcome deliverable with the path recorded', async () => {
    const deliver = { execute: async () => 'Delivered to /home/u/Documents/Mercury/T/2026-10-10 Piece.md — the owner\'s outputs zone.' } as any;
    // The tool runs inside the stream (as the SDK would run it), so the
    // wrapper's capture lands before the turn computes its outcome.
    mockedStreamText.mockImplementation(((opts: any) => ({
      fullStream: (async function* () {
        const r = await opts.tools.bot_deliver.execute({ file: 'x.md' }, {});
        opts.onStepFinish?.({ usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ toolName: 'bot_deliver', toolCallId: 'd', input: { file: 'x.md' } }], toolResults: [{ toolCallId: 'd', output: { type: 'text', value: r } }] });
        yield { type: 'text-delta', text: 'Delivered.' };
      })(),
      text: Promise.resolve('Delivered.'),
      finishReason: Promise.resolve('stop'),
      usage: Promise.resolve({}),
    })) as any);
    const out = await runBotTurn(turnInput({ trigger: 'cron', tools: { bot_deliver: deliver } }));
    expect(out.outcome).toBe('deliverable');
    expect(out.deliverables).toEqual(['/home/u/Documents/Mercury/T/2026-10-10 Piece.md']);
    expect(out.claimedWithoutAction).toBe(false);
  });
});

describe('shared-folder write budget', () => {
  const sandbox = { workspace: '/tmp/ws', shared: '/tmp/shared' };
  const writes: string[] = [];
  const write = { execute: async (args: any) => { writes.push(args.path); return `Wrote ${args.path}`; } } as any;
  it('warns past the soft limit and refuses past the hard limit, but never limits the private workspace', async () => {
    writes.length = 0;
    const tools = wrapBotTools({ write_file: write }, { sandbox, limits: { ...DEFAULT_TURN_LIMITS, sharedWrites: { softFiles: 1, softBytes: 100, hardFiles: 2, hardBytes: 1000 } }, onDelivered: () => {} });
    const a = await tools.write_file.execute!({ path: '/tmp/shared/a.md', content: 'x'.repeat(50) }, {} as any);
    expect(String(a)).toBe('Wrote /tmp/shared/a.md');
    const b = await tools.write_file.execute!({ path: '/tmp/shared/b.md', content: 'x'.repeat(60) }, {} as any);
    expect(String(b)).toContain('[Note: this run has written 2 files');
    const c = await tools.write_file.execute!({ path: '/tmp/shared/c.md', content: 'x' }, {} as any);
    expect(String(c)).toMatch(/^Error: shared-folder write budget/);
    expect(writes).toEqual(['/tmp/shared/a.md', '/tmp/shared/b.md']);
    const p = await tools.write_file.execute!({ path: '/tmp/ws/notes.md', content: 'x'.repeat(5000) }, {} as any);
    expect(String(p)).toBe('Wrote /tmp/ws/notes.md');
    // Relative paths resolve against the private workspace, not the shared folder.
    const r = await tools.write_file.execute!({ path: 'draft.md', content: 'x' }, {} as any);
    expect(String(r)).toBe('Wrote draft.md');
  });
});
