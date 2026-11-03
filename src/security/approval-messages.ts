import type { ChannelMessage } from '../types/channel.js';
import type { OwnerApproval } from './owner-approvals.js';

/**
 * How an owner approval reads on a messaging channel, and how a reply to it
 * is understood. A reply works only from the owner (an admin of that
 * channel), only with the code, and only once.
 */

const REPLY = /^\s*(approve|allow|yes|ok|deny|reject|no)\s+([A-Za-z2-9]{5})\s*[.!]?\s*$/i;

export function parseApprovalReply(text: string): { decision: 'allow' | 'deny'; code: string } | null {
  const m = REPLY.exec(text);
  if (!m) return null;
  const word = m[1].toLowerCase();
  return { decision: ['approve', 'allow', 'yes', 'ok'].includes(word) ? 'allow' : 'deny', code: m[2].toUpperCase() };
}

/** The sender is the owner on their channel: an admin (Telegram, Signal, WhatsApp roles; Discord/Slack admin flag). */
export function isOwnerSender(msg: ChannelMessage): boolean {
  if (msg.senderRole === 'admin') return true;
  return (msg.metadata as { isAdmin?: unknown } | undefined)?.isAdmin === true;
}

const minutes = (ms: number): string => `${Math.max(1, Math.round(ms / 60_000))} min`;

export function approvalRequestText(a: OwnerApproval, now = Date.now()): string {
  const head = a.kind === 'pair'
    ? `🔐 Mercury: a new device wants to connect: “${a.who}”${a.detail ? ` (${a.detail})` : ''}.`
    : `🔐 Mercury: “${a.who}” wants to: ${a.title}${a.detail ? `\n   ${a.detail}` : ''}${a.ip ? `\n   (from ${a.ip})` : ''}`;
  return `${head}\nReply “approve ${a.code}” to allow it, or “deny ${a.code}”. It expires in ${minutes(a.expiresAt - now)}.${a.kind === 'pair' ? ' If you didn’t just sign in somewhere, deny it.' : ''}`;
}

export function approvalAnsweredText(a: OwnerApproval): string {
  const what = a.kind === 'pair' ? `the device “${a.who}”` : `“${a.title}” for ${a.who}`;
  return a.status === 'allowed' ? `✓ Approved ${what}.` : `✗ Denied ${what}.`;
}

export function newLocationText(name: string, ip: string): string {
  return `🔐 Mercury: your device “${name}” connected from a new address (${ip}). If that wasn’t you, revoke it with /server on the computer Mercury runs on.`;
}
