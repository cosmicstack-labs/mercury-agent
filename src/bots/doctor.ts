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