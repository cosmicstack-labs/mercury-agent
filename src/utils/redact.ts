export function redactPhone(phone: string): string {
  if (!phone || phone.length < 6) return '***';
  const visible = phone.slice(0, 4);
  const end = phone.slice(-2);
  return `${visible}***${end}`;
}

export function redactUuid(uuid: string): string {
  if (!uuid || uuid.length < 8) return '***';
  return `${uuid.slice(0, 4)}***`;
}

export function redactIdentity(phone: string, uuid?: string): string {
  const phonePart = redactPhone(phone);
  if (uuid) {
    return `${phonePart} (${redactUuid(uuid)})`;
  }
  return phonePart;
}

/**
 * Secret redaction for logs and tool-result echoes.
 * Provider errors embed response bodies that contain API-key fragments;
 * command output can contain environment secrets — anything written to
 * persistent logs or session transcripts passes through this first.
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

export function userFacingAiError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = message.toLowerCase();
  if (/context(?:_|\s|-)?length|too many tokens|maximum context|request too large|payload too large/.test(normalized)) {
    return 'This request is too large for the selected model. Shorten the conversation or choose another model.';
  }
  if (/rate.?limit|too many requests|quota|capacity|overloaded|\b429\b/.test(normalized)) {
    return 'The selected model is temporarily busy. Please try again shortly.';
  }
  if (/timeout|timed out|deadline|stalled/.test(normalized)) {
    return 'The request timed out before Mercury could finish. Please try again.';
  }
  if (/api.?key|authenticat|unauthori[sz]ed|forbidden|credential|\b401\b|\b403\b/.test(normalized)) {
    return 'Mercury could not connect to the selected model. Please try another model or contact support.';
  }
  if (/model.+(?:not found|unavailable|unsupported|invalid)|no provider available|provider mismatch|\b404\b/.test(normalized)) {
    return 'The selected model is currently unavailable. Please choose another model or try again later.';
  }
  if (/content.?policy|safety|moderation|blocked|refused/.test(normalized)) {
    return 'The selected model could not process this request. Revise it and try again.';
  }
  return 'Mercury could not complete this request. Please try again shortly.';
}