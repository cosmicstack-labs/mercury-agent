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
