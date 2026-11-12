import { describe, expect, it, vi, beforeEach } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-desktop-parity-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome, loadConfig, type MercuryConfig } from '../../utils/config.js';
import { TokenBudget } from '../../utils/tokens.js';
import { SaverMode } from '../../core/saver-mode.js';
import budget, { setBudgetControls } from './budget.js';
import chat, { setSessionRepository, setTurnControls, type TurnControls } from './chat.js';
import { SessionRepository } from '../../sessions/repository.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import system from './system.js';

/**
 * What Mercury Desktop reads for today's runtime work (ADR-037/038, #296):
 * which chats run and wait, the concurrency limit, the token split and cache
 * weight, breakdowns that add up to the daily total.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const send = (app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, method: string, path: string, body?: unknown) =>
  app.request(`http://127.0.0.1${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('/api/chat/running and /api/chat/concurrency', () => {
  let configured = 0;
  const controls: TurnControls = {
    running: () => [{ sessionId: 's1', channelType: 'web', channelId: 's1', startedAt: 1, activity: '🔎 Searching the web', steps: 2 }],
    waiting: () => [{ sessionId: 's2', channelType: 'web', channelId: 's2', waiting: 2, position: 1 }],
    limit: () => ({ limit: configured || 4, configured, auto: 4 }),
    setLimit: (n) => { configured = n; },
  };
  beforeEach(() => { configured = 0; setTurnControls(controls); });

  it('reports running and waiting chats with the limit; activity labels are trimmed of icons', async () => {
    const body = await json(await send(chat, 'GET', '/api/chat/running'));
    expect(body).toEqual({
      limit: 4, configured: 0, auto: 4,
      running: [{ sessionId: 's1', channelType: 'web', channelId: 's1', startedAt: 1, activity: 'Searching the web', steps: 2 }],
      waiting: [{ sessionId: 's2', channelType: 'web', channelId: 's2', waiting: 2, position: 1 }],
    });
  });

  it('sets the limit (0 = automatic) and refuses anything else', async () => {
    const ok = await json(await send(chat, 'PUT', '/api/chat/concurrency', { maxTurns: 2 }));
    expect(ok).toMatchObject({ limit: 2, configured: 2 });
    for (const bad of [-1, 17, 2.5, '3', null]) {
      expect((await send(chat, 'PUT', '/api/chat/concurrency', { maxTurns: bad })).status).toBe(400);
    }
    expect(configured).toBe(2);
  });

  it('is 503 on a runtime without it wired', async () => {
    setTurnControls(null);
    expect((await send(chat, 'GET', '/api/chat/running')).status).toBe(503);
  });
});

describe('/api/budget: split and cache weight (#296)', () => {
  let config: MercuryConfig;
  let tokens: TokenBudget;
  beforeEach(() => {
    config = loadConfig();
    tokens = new TokenBudget(config);
    tokens.resetUsage();
    setBudgetControls({ config: () => config, tokens: () => tokens, saver: () => new SaverMode(config) });
  });

  it("reports today's split and the weight, and sets the weight live", async () => {
    tokens.recordUsage({ provider: 'p', model: 'm', inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cachedInputTokens: 800, noCacheInputTokens: 200, channelType: 'web' });
    const before = await json(await send(budget, 'GET', '/api/budget'));
    expect(before.daily.split).toEqual({ inputTokens: 1000, cachedInputTokens: 800, noCacheInputTokens: 200, outputTokens: 100 });
    expect(before.daily.cachedWeight).toBe(1);
    const after = await json(await send(budget, 'PUT', '/api/budget', { cachedWeight: 0.1 }));
    expect(after.daily.cachedWeight).toBe(0.1);
    // The next request counts cache hits at the new weight.
    const used = tokens.getDailyUsed();
    tokens.recordUsage({ provider: 'p', model: 'm', inputTokens: 1000, outputTokens: 0, totalTokens: 1000, cachedInputTokens: 1000, noCacheInputTokens: 0, channelType: 'web' });
    expect(tokens.getDailyUsed() - used).toBe(100);
  });

  it('refuses a weight outside 0–1', async () => {
    for (const bad of [-0.1, 1.5, 'half']) expect((await send(budget, 'PUT', '/api/budget', { cachedWeight: bad })).status).toBe(400);
  });
});

describe('/api/usage: breakdowns add up to what the budget counted', () => {
  it('sums counted tokens per provider and channel, and reports the split', async () => {
    const today = new Date().toISOString().slice(0, 10);
    writeFileSync(join(getMercuryHome(), 'token-usage.json'), JSON.stringify({
      dailyUsed: 300, dailyBudget: 1000, lastResetDate: today,
      dailySplit: { inputTokens: 2000, cachedInputTokens: 1800, noCacheInputTokens: 200, outputTokens: 100 },
      requestLog: [
        { timestamp: 1, provider: 'anthropic', model: 'm', inputTokens: 2000, outputTokens: 100, totalTokens: 2100, channelType: 'web', cachedInputTokens: 1800, countedTokens: 300 },
      ],
    }));
    const body = await json(await send(system, 'GET', '/api/usage'));
    expect(body.byProvider).toEqual({ anthropic: 300 });
    expect(body.byChannel).toEqual({ web: 300 });
    expect(body.dailyUsed).toBe(300);
    expect(body.split).toEqual({ inputTokens: 2000, cachedInputTokens: 1800, noCacheInputTokens: 200, outputTokens: 100 });
  });

  it("an old row without countedTokens counts in full; yesterday's split is not today's", async () => {
    writeFileSync(join(getMercuryHome(), 'token-usage.json'), JSON.stringify({
      dailyUsed: 50, dailyBudget: 1000, lastResetDate: '2020-01-01',
      dailySplit: { inputTokens: 1, cachedInputTokens: 0, noCacheInputTokens: 1, outputTokens: 1 },
      requestLog: [{ timestamp: 1, provider: 'x', model: 'm', inputTokens: 40, outputTokens: 10, totalTokens: 50, channelType: 'cli' }],
    }));
    const body = await json(await send(system, 'GET', '/api/usage'));
    expect(body.byProvider).toEqual({ x: 50 });
    expect(body.split).toBeUndefined();
  });
});

describe('thread messages carry what each reply cost (#296)', () => {
  it('assistant replies with recorded usage have it; others do not', async () => {
    const repo = new SessionRepository({ rootDir: mkdtempSync(join(tmpdir(), 'mercury-parity-sessions-')), autoMigrate: false });
    setSessionRepository(repo);
    const session = repo.create();
    repo.appendMessage(session.id, { role: 'user', content: 'hi', timestamp: 1 });
    repo.appendMessage(session.id, {
      role: 'assistant', content: 'hello', timestamp: 2,
      metadata: { provider: 'anthropic', model: 'claude-x', inputTokens: 12000, cachedInputTokens: 10000, noCacheInputTokens: 2000, outputTokens: 300, steps: 3, elapsedMs: 4200, traceId: 't' },
    });
    repo.appendMessage(session.id, { role: 'assistant', content: 'old reply', timestamp: 3 });
    const body = await json(await send(chat, 'GET', `/api/chat/threads/${session.id}`));
    const [user, reply, old] = body.messages;
    expect(user.usage).toBeUndefined();
    expect(reply.usage).toEqual({ provider: 'anthropic', model: 'claude-x', inputTokens: 12000, cachedInputTokens: 10000, outputTokens: 300, steps: 3, elapsedMs: 4200 });
    expect(old.usage).toBeUndefined();
  });
});
