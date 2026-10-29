import type { SessionRepository } from '../sessions/index.js';
import { voiceFeed, type VoiceRole } from './voice-feed.js';
import { logger } from '../utils/logger.js';

/**
 * Every desktop voice call is also a regular chat thread, written as it
 * happens: what the owner said, what Mercury said, and the full answers
 * behind them. Clients open it like any thread (and see it fill in live);
 * a call that ends with nothing said leaves no thread behind.
 */

const SAVED: Partial<Record<VoiceRole, 'user' | 'assistant'>> = { owner: 'user', mercury: 'assistant', result: 'assistant', approval: 'assistant' };

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function callDuration(secs: number): string {
  if (secs < 60) return `${Math.max(1, Math.round(secs))}s`;
  const m = Math.floor(secs / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function recordVoiceCalls(sessions: SessionRepository): () => void {
  let current: { callId: string; threadId: string; startedAt: number; saved: number } | null = null;

  return voiceFeed.subscribe((ev) => {
    try {
      const s = ev.state;
      if (ev.type === 'state') {
        if (s.active && s.callId && current?.callId !== s.callId) {
          const startedAt = s.startedAt ?? Date.now();
          const session = sessions.create({ title: `Voice call · ${clock(startedAt)}`, titleSource: 'user' });
          current = { callId: s.callId, threadId: session.id, startedAt, saved: 0 };
          voiceFeed.setThread(session.id);
        } else if (!s.active && current && s.endedAt) {
          const done = current;
          current = null;
          if (done.saved === 0) {
            // Nothing was said (a failed start, a press by accident): no empty thread in the list.
            sessions.markDeleted(done.threadId);
            return;
          }
          const secs = (s.endedAt - done.startedAt) / 1000;
          sessions.updateTitle(done.threadId, `Voice call · ${clock(done.startedAt)} · ${callDuration(secs)}`, 'user');
        }
        return;
      }
      if (ev.type === 'turn' && ev.turn && current) {
        const role = SAVED[ev.turn.role];
        if (!role) return;
        const content = ev.turn.role === 'approval' ? `Asked to go ahead: ${ev.turn.text}` : ev.turn.text;
        sessions.appendMessage(current.threadId, {
          role,
          content,
          timestamp: ev.turn.at,
          metadata: { voiceCall: current.callId, voiceRole: ev.turn.role },
        });
        current.saved += 1;
      }
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Could not save the voice call to its chat thread');
    }
  });
}
