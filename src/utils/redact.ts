/**
 * Identity redaction helpers for logs.
 *
 * Phone numbers and Signal UUIDs are personally identifying. They are useful
 * for debugging access-control decisions, but should never land in logs in
 * full. These helpers keep just enough of the tail to correlate events while
 * masking the rest.
 */

/**
 * Redact an E.164 phone number, keeping the leading `+`, the country prefix,
 * and the last 4 digits: `+15551234567` → `+155****4567`.
 *
 * Short or non-standard values fall back to masking all but the last 2 chars.
 */
export function redactPhone(value?: string | null): string {
  if (!value) return '';
  const str = String(value);

  if (str.startsWith('+')) {
    const digits = str.slice(1);
    if (digits.length <= 6) {
      // Too short to keep a meaningful prefix + suffix; mask all but last 2.
      return '+' + maskAllButLast(digits, 2);
    }
    const head = digits.slice(0, 3);
    const tail = digits.slice(-4);
    return `+${head}****${tail}`;
  }

  return maskAllButLast(str, 2);
}

/**
 * Redact a Signal UUID, keeping only the last 4 chars:
 * `e5b1c0de-1234-...-b20b2` → `****b20b2`.
 */
export function redactUuid(value?: string | null): string {
  if (!value) return '';
  const str = String(value);
  return '****' + str.slice(-4);
}

/**
 * Redact an identifier whose type isn't known up front (Signal's `source`
 * match key can be either a phone number or a UUID). Dispatches on shape.
 */
export function redactIdentity(value?: string | null): string {
  if (!value) return '';
  const str = String(value);
  if (str.startsWith('+')) return redactPhone(str);
  // UUIDs contain hyphens or are long hex-ish strings; phone-like all-digit
  // strings are rare here but handled by the phone branch above.
  return redactUuid(str);
}

function maskAllButLast(str: string, keep: number): string {
  if (str.length <= keep) return '*'.repeat(str.length);
  return '*'.repeat(str.length - keep) + str.slice(-keep);
}
