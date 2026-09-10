/**
 * Locale-independent number formatting.
 *
 * `Number.prototype.toLocaleString()` is machine-dependent — on hosts with an
 * Indian locale it renders `2,00,000` instead of `200,000`, which makes agent
 * output (budget text, notifications, sub-agent summaries) vary per machine.
 * All user-facing numbers should go through this formatter instead.
 */
export function formatNumber(value: number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-US', { useGrouping: true });
}