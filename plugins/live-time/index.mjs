// Independently implemented Mercury time lookup; see LICENSE for attribution.
export function currentTime(args = {}, now = new Date()) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'Expected an object.' };
  if (Object.keys(args).some((key) => key !== 'timezone')) return { ok: false, error: 'Unknown argument.' };
  if (Number.isNaN(now.getTime())) return { ok: false, error: 'Invalid clock value.' };
  const timezone = args.timezone;
  if (timezone !== undefined && (typeof timezone !== 'string' || !timezone.length || timezone.length > 100)) {
    return { ok: false, error: 'timezone must be a nonempty IANA zone name of at most 100 characters.' };
  }
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      ...(timezone === undefined ? {} : { timeZone: timezone }),
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      timeZoneName: 'longOffset',
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
    return {
      ok: true,
      utc: now.toISOString(),
      epoch_ms: now.getTime(),
      timezone: formatter.resolvedOptions().timeZone,
      local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
      weekday: parts.weekday,
      offset: parts.timeZoneName,
      clock_source: 'host-system-clock',
      limitations: 'Point-in-time lookup only; no clock synchronization or automatic prompt injection.',
    };
  } catch {
    return { ok: false, error: 'Unsupported timezone or unavailable timezone data.' };
  }
}

export function activate(ctx) {
  ctx.tools.register({
    name: 'now',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { timezone: { type: 'string', minLength: 1, maxLength: 100, description: 'Optional IANA timezone, such as America/Chicago. Defaults to host timezone.' } },
    },
    execute(args) { return currentTime(args); },
  });
}
