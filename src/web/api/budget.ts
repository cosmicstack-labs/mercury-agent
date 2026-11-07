import { Hono } from 'hono';
import { saveConfig, type MercuryConfig } from '../../utils/config.js';
import type { TokenBudget } from '../../utils/tokens.js';
import type { SaverMode } from '../../core/saver-mode.js';

/**
 * Token budgets, readable and settable from any client. Saves apply live
 * and persist to mercury.yaml.
 *
 *   GET /api/budget  → { daily, saver, bots }
 *   PUT /api/budget  { dailyBudget?, saver?: { manual?, autoEnabled?, autoThreshold? },
 *                      bots?: { perBot?, fleet? } } → the same shape as GET
 *
 * daily:  today's tokens against the daily cap (Mercury pauses at the cap).
 * saver:  Token Saver: on by hand, or on by itself at a share of the cap.
 * bots:   the cap a bot gets when it sets none, and the cap for all bots
 *         together (0 = no cap).
 */

export interface BudgetControls {
  config: () => MercuryConfig;
  tokens: () => TokenBudget;
  saver: () => SaverMode;
}

let controls: BudgetControls | undefined;
export function setBudgetControls(c: BudgetControls | undefined): void { controls = c; }

const MAX = 1_000_000_000_000;

function snapshot(c: BudgetControls) {
  const tokens = c.tokens();
  const saver = c.saver();
  const cfg = c.config();
  return {
    daily: {
      budget: tokens.getBudget(),
      used: tokens.getDailyUsed(),
      remaining: tokens.getRemaining(),
      percentage: Math.round(tokens.getUsagePercentage()),
    },
    saver: {
      state: saver.getState(),
      autoEnabled: saver.isAutoEnabled(),
      autoThreshold: saver.getAutoThreshold(),
      savedToday: tokens.getSavedToday(),
      savedLifetime: tokens.getSavedLifetime(),
    },
    bots: {
      enabled: !!cfg.bots?.enabled,
      perBot: cfg.bots?.suggestedDailyTokenBudget ?? 5_000_000,
      fleet: cfg.bots?.fleetDailyTokenBudget ?? 0,
    },
  };
}

/** A whole number of tokens in range, or an error message. */
function tokensFrom(value: unknown, what: string, min: number): number | string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `${what} must be a number of tokens.`;
  const n = Math.round(value);
  if (n < min) return `${what} must be at least ${min.toLocaleString()} tokens.`;
  if (n > MAX) return `${what} is too large.`;
  return n;
}

const budget = new Hono();

budget.get('/api/budget', (c) => {
  if (!controls) return c.json({ error: 'Budgets are not available yet.' }, 503);
  return c.json(snapshot(controls));
});

budget.put('/api/budget', async (c) => {
  if (!controls) return c.json({ error: 'Budgets are not available yet.' }, 503);
  const body = (await c.req.json().catch(() => ({}))) as {
    dailyBudget?: unknown;
    saver?: { manual?: unknown; autoEnabled?: unknown; autoThreshold?: unknown };
    bots?: { perBot?: unknown; fleet?: unknown };
  };

  // Check everything first, so a bad field changes nothing.
  const daily = body.dailyBudget === undefined ? undefined : tokensFrom(body.dailyBudget, 'The daily budget', 1_000);
  const perBot = body.bots?.perBot === undefined ? undefined : tokensFrom(body.bots.perBot, 'The per-bot budget', 0);
  const fleet = body.bots?.fleet === undefined ? undefined : tokensFrom(body.bots.fleet, 'The all-bots budget', 0);
  for (const v of [daily, perBot, fleet]) if (typeof v === 'string') return c.json({ error: v }, 400);
  const s = body.saver ?? {};
  if (s.manual !== undefined && typeof s.manual !== 'boolean') return c.json({ error: 'saver.manual must be true or false.' }, 400);
  if (s.autoEnabled !== undefined && typeof s.autoEnabled !== 'boolean') return c.json({ error: 'saver.autoEnabled must be true or false.' }, 400);
  if (s.autoThreshold !== undefined && (typeof s.autoThreshold !== 'number' || !Number.isFinite(s.autoThreshold) || s.autoThreshold < 1 || s.autoThreshold > 100)) {
    return c.json({ error: 'saver.autoThreshold must be a percentage from 1 to 100.' }, 400);
  }

  const tokens = controls.tokens();
  const saver = controls.saver();
  if (typeof daily === 'number') tokens.setBudget(daily);
  if (typeof s.autoThreshold === 'number') saver.setAutoThreshold(s.autoThreshold);
  if (typeof s.autoEnabled === 'boolean') saver.setAutoEnabled(s.autoEnabled);
  if (s.manual === true && !saver.isManual()) saver.enable();
  if (s.manual === false && saver.isManual()) saver.disable();
  if (typeof perBot === 'number' || typeof fleet === 'number') {
    const cfg = controls.config();
    cfg.bots = cfg.bots ?? ({} as MercuryConfig['bots']);
    if (typeof perBot === 'number') cfg.bots.suggestedDailyTokenBudget = perBot;
    if (typeof fleet === 'number') cfg.bots.fleetDailyTokenBudget = fleet;
    saveConfig(cfg);
  }
  return c.json(snapshot(controls));
});

export default budget;
