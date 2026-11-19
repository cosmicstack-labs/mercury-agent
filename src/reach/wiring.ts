/**
 * Puts calls and notifications from Mercury together at boot (ADR-046):
 * the reach service's fallbacks, the phone call scheduler ("call me at
 * 9pm" ringing the Mercury app) and the owner's "call when something's
 * wrong" triggers.
 */
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { listLiveTools } from '../plugins/tool-bridge.js';
import { CallScheduler, PHONE_SCHEDULER_ID, registerCallScheduler, setPhoneSchedulerAvailability, type ScheduledCall } from '../plugins/call-schedule.js';
import { listPhones } from '../web/devices.js';
import { reachService, type ReachService } from './service.js';
import { setPhoneToolsAvailability } from './tools.js';
import { readReachSettings, reachDir, type TriggerAction } from './settings.js';
import type { BotInboxEntry } from '../bots/inbox.js';
import type { BackgroundTask } from '../core/background-tasks.js';

/** Outcomes that already reached the owner some other way, or were their own answer: no retry, no missed note. */
const SETTLED = /^(declined|disabled|below_threshold|quiet|rate_limited)/;

/** WhatsApp's call_owner tool (any running channel plugin that has one). */
export function whatsappCaller(): ((reason: string) => Promise<string>) | null {
  const tool = listLiveTools().find((t) => t.name === 'call_owner');
  if (!tool) return null;
  return async (reason) => String(await tool.invoke({ reason }, new AbortController().signal));
}

export function scheduledCallReason(c: ScheduledCall): string {
  return `you asked me to call${c.topic !== 'checking in' ? ` about ${c.topic}` : ' you now'}`;
}

export interface PhoneReachWiring {
  scheduler: CallScheduler;
  stop: () => void;
}

export interface PhoneReachOptions {
  messageOwner: (text: string) => Promise<void>;
  service?: ReachService;
  /** Where the phone's scheduled calls live (default ~/.mercury/reach). */
  dir?: string;
}

/** Make the phone call scheduler and connect the reach service's fallbacks. */
export function setupPhoneReach(opts: PhoneReachOptions): PhoneReachWiring {
  const service = opts.service ?? reachService();
  const scheduler = new CallScheduler(PHONE_SCHEDULER_ID, opts.messageOwner, {
    dir: opts.dir ?? reachDir(),
    // The owner scheduled this call themselves; it can only ring them.
    place: async (c) => (await service.callOwner({ reason: scheduledCallReason(c), source: 'scheduled', followUp: false, ...c.target })).text,
    retryable: (outcome) => !SETTLED.test(outcome),
    giveUp: async (c, outcome) => {
      if (SETTLED.test(outcome)) return;
      await service.missedCall(c.topic);
    },
  });
  service.setDeps({
    whatsappCall: whatsappCaller,
    messageOwner: opts.messageOwner,
    scheduleRetry: (reason, target) => { scheduler.retryLater(reason, undefined, target); },
  });
  const hasPhone = () => listPhones().length > 0;
  setPhoneSchedulerAvailability(hasPhone);
  setPhoneToolsAvailability(hasPhone);
  registerCallScheduler(PHONE_SCHEDULER_ID, scheduler);
  scheduler.start();
  return {
    scheduler,
    stop: () => {
      registerCallScheduler(PHONE_SCHEDULER_ID, null);
      setPhoneSchedulerAvailability(() => false);
      setPhoneToolsAvailability(() => false);
    },
  };
}

/** A background task this long that fails is worth telling the owner about. */
export const LONG_TASK_MS = 10 * 60_000;

async function act(service: ReachService, action: TriggerAction, title: string, body: string): Promise<void> {
  if (action === 'off') return;
  if (action === 'call') {
    await service.callOwner({ reason: `${title}${body ? `: ${body.slice(0, 200)}` : ''}`, urgency: 'high', source: 'trigger' });
    return;
  }
  await service.notifyOwner({ title, body: body.slice(0, 400), kind: 'alert', urgency: 'high', source: 'trigger' });
}

/** A bot inbox entry → the owner's trigger setting for it. */
export function onBotInboxEntry(e: BotInboxEntry, service: ReachService = reachService()): Promise<void> {
  const t = readReachSettings().triggers;
  const action = e.kind === 'needs-you' ? t.botNeedsYou : e.kind === 'failed' ? t.botFailed : 'off';
  return act(service, action, e.title || `${e.botName} needs you`, e.summary).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'Could not reach the owner about a bot');
  });
}

/** A finished background task → the owner's trigger setting, when a long one failed. */
export function onBackgroundTaskDone(task: BackgroundTask, service: ReachService = reachService()): Promise<void> {
  if (task.status !== 'failed' && task.status !== 'timed_out') return Promise.resolve();
  if ((task.completedAt ?? Date.now()) - task.startedAt < LONG_TASK_MS) return Promise.resolve();
  const what = (task.task ?? task.command ?? task.id).replace(/\s+/g, ' ').slice(0, 80);
  const tail = (task.stderr || task.stdout).trim().split('\n').slice(-3).join('\n');
  return act(service, readReachSettings().triggers.longTaskFailed, `Background task ${task.status === 'timed_out' ? 'timed out' : 'failed'}: ${what}`, tail).catch((err) => {
    logger.warn({ err: (err as Error).message }, 'Could not reach the owner about a task');
  });
}

/** Where the phone's scheduled calls file lives (for docs and tests). */
export function phoneScheduleFile(): string {
  return join(reachDir(), 'scheduled-calls.json');
}
