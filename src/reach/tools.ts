/**
 * The agent's tools for reaching the owner on their phone (ADR-046):
 * `call_owner` rings the Mercury app (then WhatsApp, then a note) and
 * `notify_owner` sends a notification. Both only ever reach the owner.
 *
 * Security (ADR-044, security/tool-guard.ts): both are OUTBOUND sinks. In a
 * turn that read outside content they need the owner's explicit yes, so
 * that content alone can never make Mercury ring or notify. A scheduled
 * run may use them unattended (the owner approved the task), unless what it
 * read carried instructions to an AI. The reach service rate-limits both.
 */
import { tool, zodSchema, type Tool } from 'ai';
import { z } from 'zod';
import type { PermissionManager } from '../capabilities/permissions.js';
import { reachService, type ReachSource } from './service.js';
import { listPhones } from '../web/devices.js';
import { isLive } from './presence.js';
import { phoneLabel, resolvePhoneTarget } from './target.js';
import { URGENCIES } from './settings.js';

let available: () => boolean = () => false;

/** Whether this process offers the phone tools (it runs the server the phones connect to, and a phone is paired). */
export function setPhoneToolsAvailability(fn: () => boolean): void {
  available = fn;
}

export function phoneToolsAvailable(): boolean {
  try { return available(); } catch { return false; }
}

function sourceOf(p: PermissionManager): ReachSource {
  return p.getCurrentChannelType() === 'internal' || p.isFailClosed() ? 'scheduled' : 'agent';
}

/** The paired phones as the model should name them, and whether each can ring right now. */
function pairedPhonesLine(): string {
  try {
    const phones = listPhones();
    if (!phones.length) return '';
    return ` Paired phones: ${phones.map((d) => `${phoneLabel(d)} (${isLive(d.id) ? 'connected' : 'not connected'})`).join(', ')}.`;
  } catch { return ''; }
}

export function createPhoneTools(permissions: PermissionManager): Record<string, Tool> {
  return {
    call_owner: tool({
      description:
        "Ring the owner's phone right now (a real incoming call in the Mercury app) and talk to them by voice when they answer. " +
        "If the owner names a device or the app (\"call me on my iPhone\", \"on the vivo\", \"in the Mercury app\"), pass it as `device`: ONLY that rings — never WhatsApp — and if it isn't connected you're told so; tell the owner rather than calling another way. " +
        "Without `device`, any connected phone rings; if none or no answer, Mercury tries WhatsApp (when linked), retries once after 5 minutes, then leaves a missed-call note: don't call again yourself. " +
        'Use it only for things that matter now (the owner asked to be called, or something important went wrong); send notify_owner for everything else. ' +
        'Rate-limited and subject to the owner\'s quiet hours. To call LATER ("call me at 9pm"), use schedule_call.' + pairedPhonesLine(),
      inputSchema: zodSchema(z.object({
        reason: z.string().min(1).max(300).describe('Why you are calling, in one sentence. Mercury says it first when the owner answers.'),
        opener: z.string().max(500).optional().describe('What to say first, if different from the reason'),
        urgency: z.enum(URGENCIES).optional().describe('normal (default), high when something is wrong, critical only for emergencies (rings through quiet hours)'),
        device: z.string().max(80).optional().describe('Only when the owner named where to call: a paired phone\'s name or kind ("iPhone", "Android", "vivo", "Salman\'s iPhone"), or "Mercury app" for any of their phones but not WhatsApp. Leave out otherwise.'),
      })),
      execute: async ({ reason, opener, urgency, device }) => {
        const target = resolvePhoneTarget(device, listPhones());
        if (target.kind === 'unknown') return `not_called: ${target.message}`;
        const r = await reachService().callOwner({
          reason, opener, urgency: urgency ?? 'normal', source: sourceOf(permissions),
          ...(target.kind === 'device' ? { deviceIds: target.deviceIds, appOnly: true, targetLabel: target.label } : {}),
          ...(target.kind === 'app' ? { appOnly: true, targetLabel: target.label } : {}),
        });
        return r.text;
      },
    }),
    notify_owner: tool({
      description:
        "Send the owner a notification on their phone (the Mercury app): a short title and body. If no phone is connected, it waits in the app until it next opens " +
        '(high urgency also goes to their messaging channel). Only the owner receives it. Rate-limited.',
      inputSchema: zodSchema(z.object({
        title: z.string().min(1).max(120),
        body: z.string().max(1000).describe('One or two sentences'),
        kind: z.enum(['info', 'alert', 'reminder', 'result']).optional(),
        urgency: z.enum(URGENCIES).optional(),
      })),
      execute: async ({ title, body, kind, urgency }) => {
        const r = await reachService().notifyOwner({ title, body, kind: kind ?? 'info', urgency: urgency ?? 'normal', source: sourceOf(permissions) });
        return r.text;
      },
    }),
  };
}
