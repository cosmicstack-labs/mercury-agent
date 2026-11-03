import type { ServerUpdateStatus } from './status.js';

/**
 * What the terminal chat says about updates when it opens. Calm by default
 * (an available update is mentioned once per version and can be ignored),
 * firm when it matters (a required update is said every time and can't be
 * ignored), and messages from the manifest once each (a critical one that
 * can't be dismissed, every time).
 */

export interface StartupNotices {
  notices: string[];
  /** The version for the status bar's "update available" mark, or null. */
  badge: string | null;
  /** Message ids now shown (remember them so they don't repeat). */
  shown: string[];
}

export function startupNotices(s: ServerUpdateStatus, ignored: string | undefined, alreadyShown: ReadonlySet<string>): StartupNotices {
  const notices: string[] = [];
  const shown: string[] = [];
  let badge: string | null = null;

  if (s.required) {
    badge = s.latest?.version ?? s.required.version;
    const how = s.canSelfUpdate ? 'Run `mercury upgrade` in your terminal (it goes back on its own if anything fails).' : (s.cannotReason ?? 'Reinstall from mercuryagent.sh.');
    notices.push(`⛔ **Update required${s.required.severity === 'security' ? ' (security)' : ''}.** ${s.required.reason} Mercury v${s.current} is below v${s.required.version}. ${how}`);
  } else if (s.updateAvailable && s.latest && ignored !== s.latest.version && !s.blocked) {
    badge = s.latest.version;
    notices.push(`⬆ Update available: v${s.current} → v${s.latest.version}. Run \`mercury upgrade\` in your terminal when you're ready (\`mercury update\` shows what's new), or ignore this version with \`/update ignore\`.`);
  }

  for (const m of s.messages) {
    const sticky = m.level === 'critical' && m.dismissible === false;
    if (!sticky && alreadyShown.has(m.id)) continue;
    const icon = m.level === 'critical' ? '⛔' : m.level === 'warning' ? '⚠' : 'ℹ';
    notices.push(`${icon} **${m.title}**${m.body ? `\n${m.body}` : ''}${m.link ? `\n${m.link.label}: ${m.link.url}` : ''}`);
    if (!sticky) shown.push(m.id);
  }
  return { notices, badge, shown };
}

/** `mercury doctor`'s one line about updates. */
export function updatesLine(s: ServerUpdateStatus): { text: string; level: 'ok' | 'note' | 'risk' } {
  const head = `  Updates: v${s.current}`;
  if (s.required) return { level: 'risk', text: `${head} — update required${s.required.severity === 'security' ? ' (security)' : ''}: ${s.required.reason} Run \`mercury upgrade\`` };
  if (s.job && !['done', 'rolled-back', 'failed', 'cancelled'].includes(s.job.state)) return { level: 'note', text: `${head} — updating to v${s.job.to}: ${s.job.message}` };
  if (s.blocked) return { level: 'note', text: `${head} — v${s.blocked.version} failed to install ${s.blocked.failures} times (${s.blocked.lastError}); \`mercury upgrade\` tries again` };
  if (s.job?.state === 'rolled-back' && s.job.to === s.latest?.version) return { level: 'note', text: `${head} — the update to v${s.job.to} went back: ${s.job.error ?? 'it did not start'}` };
  if (s.updateAvailable && s.latest) return { level: 'note', text: `${head} — v${s.latest.version} is available (\`mercury upgrade\`)` };
  if (!s.latest) return { level: 'ok', text: `${head} — couldn't check for updates` };
  return { level: 'ok', text: `${head} — up to date` };
}
