import { describe, expect, it, vi, beforeEach } from 'vitest';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-budget-route-'));
  fs.writeFileSync(path.join(dir, 'mercury.yaml'), 'identity:\n  owner: Test\n');
  process.env.MERCURY_HOME = dir;
});

import { loadConfig, type MercuryConfig } from '../../utils/config.js';
import { TokenBudget } from '../../utils/tokens.js';
import { SaverMode } from '../../core/saver-mode.js';
import budget, { setBudgetControls } from './budget.js';

let config: MercuryConfig;
let tokens: TokenBudget;
let saver: SaverMode;

beforeEach(() => {
  config = loadConfig();
  tokens = new TokenBudget(config);
  tokens.setBudget(1_000_000);
  saver = new SaverMode(config);
  saver.disable();
  setBudgetControls({ config: () => config, tokens: () => tokens, saver: () => saver });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();
const put = (body: unknown) => budget.request('http://127.0.0.1/api/budget', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

/** Budgets from any client: what they are, and setting them, live. */
describe('/api/budget', () => {
  it('reports the daily cap, Token Saver and the bot caps', async () => {
    const res = await budget.request('http://127.0.0.1/api/budget');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      daily: { budget: 1_000_000, used: expect.any(Number) },
      saver: { state: 'off', autoEnabled: expect.any(Boolean), autoThreshold: expect.any(Number) },
      bots: { perBot: expect.any(Number), fleet: expect.any(Number) },
    });
  });

  it('sets the daily cap live and saves it', async () => {
    const res = await put({ dailyBudget: 2_500_000 });
    expect(res.status).toBe(200);
    expect((await json(res)).daily.budget).toBe(2_500_000);
    expect(tokens.getBudget()).toBe(2_500_000);
    expect(loadConfig().tokens.dailyBudget).toBe(2_500_000);
  });

  it('turns Token Saver on and sets when it comes on by itself', async () => {
    const body = await json(await put({ saver: { manual: true, autoEnabled: true, autoThreshold: 60 } }));
    expect(body.saver).toMatchObject({ state: 'on', autoEnabled: true, autoThreshold: 60 });
    expect((await json(await put({ saver: { manual: false } }))).saver.state).toBe('off');
  });

  it('sets the bot caps', async () => {
    const body = await json(await put({ bots: { perBot: 300_000, fleet: 0 } }));
    expect(body.bots).toMatchObject({ perBot: 300_000, fleet: 0 });
    expect(loadConfig().bots.suggestedDailyTokenBudget).toBe(300_000);
  });

  it('changes nothing when one field is wrong', async () => {
    const res = await put({ dailyBudget: 3_000_000, saver: { autoThreshold: 400 } });
    expect(res.status).toBe(400);
    expect(tokens.getBudget()).toBe(1_000_000);
    expect((await put({ dailyBudget: 10 })).status).toBe(400);
    expect((await put({ dailyBudget: 'lots' })).status).toBe(400);
  });
});
