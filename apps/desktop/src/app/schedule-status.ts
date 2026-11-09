import type { ScheduleInfo } from './pulse';

export function scheduleIsActive(schedule: ScheduleInfo): boolean {
  const run = typeof schedule.lastRun === 'object' ? schedule.lastRun : undefined;
  if (schedule.paused || run?.status === 'failed' || run?.status === 'interrupted') return false;
  return !!schedule.cron || !run || run.status === 'running';
}

export function scheduleDetail(schedule: ScheduleInfo): string {
  const run = typeof schedule.lastRun === 'object' ? schedule.lastRun : undefined;
  const status = run?.status === 'dispatched' ? 'dispatched to bot queue' : run?.status;
  const state = schedule.paused ? `${status ?? 'pending'} · paused`
    : status === 'running' ? status
    : schedule.cron ? `scheduled${status ? ` · last run ${status}` : ''}` : status ?? 'pending';
  const when = (date: string) => new Date(date).toLocaleString([], { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' });
  const timing = schedule.cron ? `${cronLabel(schedule.cron)} · ${schedule.timezone ?? 'host timezone'}`
    : schedule.executeAt ? `${scheduleIsActive(schedule) ? 'due' : 'was due'} ${when(schedule.executeAt)}`
    : schedule.delaySeconds ? `delay ${schedule.delaySeconds}s` : '';
  return [state, timing, schedule.botId ? `bot ${schedule.botId}` : '', schedule.nextRun && scheduleIsActive(schedule) ? `next ${when(schedule.nextRun)}` : ''].filter(Boolean).join(' · ');
}

function cronLabel(cron: string): string {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(cron.trim());
  if (m) return `every ${m[1]} min`;
  const h = /^0 \*\/(\d+) \* \* \*$/.exec(cron.trim());
  if (h) return `every ${h[1]} h`;
  return cron;
}
