/**
 * Secret redaction for logs and tool-result echoes.
 *
 * Provider errors embed response bodies that contain API-key fragments;
 * command output can contain environment secrets. Both surfaces end up in
 * persistent logs and session transcripts — anything written there must
 * pass through this redaction first.
 */

const SECRET_PATTERNS: RegExp[] = [
  // OpenAI / Anthropic / DeepSeek style keys
  /\bsk-(?:proj-|ant-|svcacct-)?[A-Za-z0-9_-]{16,}\b/g,
  // GitHub tokens
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // AWS
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack tokens
  /\bxox[bapr]-[A-Za-z0-9-]{10,}\b/g,
  // Bearer / authorization headers
  /\b(?:Bearer|token|authorization)\s+[:=]?\s*[A-Za-z0-9._~+/-]{24,}/gi,
  // Generic key=value secrets in config output
  /\b(api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}/gi,
];

/** Keep enough of the key to identify it, mask the rest. */
function maskMatch(match: string): string {
  if (match.length <= 8) return '****';
  const keep = 4;
  return `${match.slice(0, 4)}****${match.slice(-4)}`;
}

export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, maskMatch);
  }
  return out;
}

/**
 * Recursively redact strings inside an arbitrary object (error properties,
 * nested bodies) for safe logging. Non-destructive: returns a redacted copy.
 */
export function redactDeep(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}