import type { BotStore } from './store.js';
import type { BotQueue } from './queue.js';
import { validateBotManifest } from './store.js';
import type { BotRunRecord } from './types.js';
import type { BotJournal } from './journal.js';

export interface DoctorFinding {
  botId: string;
  severity: 'error' | 'warning';
  check: string;
  detail: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  healthy: boolean;
  checked: number;
}

export interface DoctorDeps {
  store: BotStore;
  queue: BotQueue;
  journalFor: (botId: string) => BotJournal;
  /** Scheduled manifests by id (bot:<id>:<name>) for next-run overdue checks. */
  scheduledRoutineIds?: string[];
  /** Grace window (minutes) before an overdue schedule counts as not firing. */
  graceMinutes?: number;
}

/**
 * Read-only fleet health check — the Hermes `cron doctor` pattern:
 * groups per-bot issues no other surface shows at once. Exit-code bearing:
 * `healthy === false` maps to exit 1 so watchdogs/CI can gate on it.
 */
export function runBotDoctor(deps: DoctorDeps): DoctorReport {
  const findings: DoctorFinding[] = [];
  const manifests = deps.store.list();
  const dlqByBot = new Map<string, number>();
  for (const entry of deps.queue.listDlq()) {
    dlqByBot.set(entry.botId, (dlqByBot.get(entry.botId) ?? 0) + 1);
  }

  for (const manifest of manifests) {
    const errors = validateBotManifest(manifest);
    if (errors.length > 0) {
      findings.push({ botId: manifest.id, severity: 'error', check: 'config', detail: errors.join('; ') });
    }

    // Malformed permissions.yaml entries (missing/empty `scope` — typically a
    // hand-edit typo) are skipped by the registry at build time; flag them so
    // the grant silently NOT applying is visible (the cron-doctor class of
    // "configured but not effective").
    const perms = deps.store.readPermissions(manifest.id);
    const malformed = (perms.paths ?? []).filter(p => !p || typeof p.scope !== 'string' || p.scope.trim().length === 0);
    if (malformed.length > 0) {
      findings.push({
        botId: manifest.id,
        severity: 'error',
        check: 'permissions',
        detail: `${malformed.length} path-scope entr(ies) missing a "scope" value in permissions.yaml — the grant is skipped (check for typos like "socpe:")`,
      });
    }

    // Fleet hierarchy integrity: a crew bot whose lead no longer exists is
    // orphaned — it can never be dispatched to, monitored, or retired.
    if (manifest.parent && !manifests.some(m => m.id === manifest.parent)) {
      findings.push({
        botId: manifest.id,
        severity: 'error',
        check: 'fleet',
        detail: `Crew bot's lead "${manifest.parent}" no longer exists — detach with /bots edit or re-point the parent`,
      });
    }

    // ADR-020: a bot whose unattended runs mostly produce nothing is
    // spending tokens on commentary — the owner should look at its persona.
    const recent = deps.journalFor(manifest.id).read(manifest.id, 20).filter(r => r.outcome !== undefined && (r.trigger === 'cron' || r.trigger === 'api'));
    if (recent.length >= 4) {
      const none = recent.filter(r => r.outcome === 'none').length;
      if (none * 2 >= recent.length) {
        findings.push({
          botId: manifest.id,
          severity: 'warning',
          check: 'outcome',
          detail: `${none} of the last ${recent.length} unattended runs produced no deliverable or action — check the persona for instructions that reward activity over results`,
        });
      }
      const claimed = recent.filter(r => r.claimedWithoutAction).length;
      if (claimed > 0) {
        findings.push({ botId: manifest.id, severity: 'warning', check: 'outcome', detail: `${claimed} run(s) claimed delivery or execution the tool trace does not show` });
      }
    }
    const routineState = deps.store.readRoutineState(manifest.id);
    for (const [key, info] of Object.entries(routineState.paused)) {
      findings.push({ botId: manifest.id, severity: 'warning', check: 'routine', detail: `routine "${key.split(':').pop()}" paused since ${info.since.slice(0, 16).replace('T', ' ')}: ${info.reason} — /bots start ${manifest.id} resumes it` });
    }
    const homeGrant = (perms.paths ?? []).find(p => p && typeof p.scope === 'string' && /^~[\\/]?$/.test(p.scope.trim()) && p.write);
    if (homeGrant) {
      findings.push({ botId: manifest.id, severity: 'warning', check: 'permissions', detail: 'write access to the whole home directory — an unattended bot can write anywhere; prefer specific scopes (/bots permissions)' });
    }
    const dlqDepth = dlqByBot.get(manifest.id) ?? 0;
    if (dlqDepth > 0) {
      findings.push({
        botId: manifest.id,
        severity: dlqDepth > 5 ? 'error' : 'warning',
        check: 'dlq',
        detail: `${dlqDepth} dead-lettered job(s) awaiting review or replay`,
      });
    }

    const journal = deps.journalFor(manifest.id);
    const counts = journal.counts(manifest.id);
    if (counts.total > 0) {
      const recent = journal.read(manifest.id, 5);
      const last = recent[recent.length - 1];
      if (last && last.state === 'failed') {
        findings.push({
          botId: manifest.id,
          severity: 'error',
          check: 'last-run',
          detail: `Last run ${last.runId} failed${last.reasonCode ? ` [reason: ${last.reasonCode}]` : ''}${last.error ? `: ${last.error.slice(0, 120)}` : ''}`,
        });
      }
    }
    if (manifest.enabled === false) continue;
    for (const routine of manifest.schedules ?? []) {
      const id = `bot:${manifest.id}:${routine.name}`;
      if (deps.scheduledRoutineIds && !deps.scheduledRoutineIds.includes(id)) {
        findings.push({
          botId: manifest.id,
          severity: 'warning',
          check: 'schedule-registered',
          detail: `Routine "${routine.name}" is configured in bot.yaml but not registered in the scheduler — run \`mercury restart\` to register bot routines`,
        });
      }
    }
  }

  // Bots referenced in schedules or DLQ but missing from the profile store.
  for (const [botId, depth] of dlqByBot) {
    if (!manifests.some(m => m.id === botId)) {
      findings.push({ botId, severity: 'warning', check: 'orphan-dlq', detail: `${depth} DLQ entries for a bot with no profile` });
    }
  }

  return {
    findings,
    healthy: findings.every(f => f.severity !== 'error'),
    checked: manifests.length,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  if (report.findings.length === 0) {
    return `✅ Bot fleet healthy — ${report.checked} bot(s) checked, nothing actionable.`;
  }
  const lines: string[] = [];
  const errors = report.findings.filter(f => f.severity === 'error');
  const warnings = report.findings.filter(f => f.severity === 'warning');
  lines.push(`⚠ Bot fleet: ${errors.length} actionable, ${report.findings.length - errors.length} warning(s) — ${report.checked} bot(s) checked`, '');
  for (const finding of report.findings) {
    const icon = finding.severity === 'error' ? '❌' : '⚠️';
    lines.push(`${icon} [${finding.botId}] ${finding.check}: ${finding.detail}`);
  }
  return lines.join('\n');
}

// Re-exported for the doctor UI's last-run window check.
export type { BotRunRecord };