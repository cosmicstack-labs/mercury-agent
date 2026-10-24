/**
 * The owner's own words, with channel scaffolding removed. Voice-call and
 * desktop turns arrive with bracketed guidance prepended to the user
 * message ("[Voice call: the owner asked this out loud. …]"); that text is
 * Mercury's, not the owner's, and must never become evidence about them.
 */
export function ownerWords(content: string): string {
  let text = content.trim();
  for (let i = 0; i < 4; i++) {
    const m = /^\[[^\]]{0,4000}\]\s*/.exec(text);
    if (!m) break;
    text = text.slice(m[0].length);
  }
  return text.replace(/^\(voice note transcribed\)\s*/i, '').trim();
}

const SECRET_RE = /\b(password|passwd|passcode|pin code|otp|one[- ]time code|api[ _-]?key|secret|token|bearer|private key|seed phrase|recovery (code|phrase)|credit card|cvv|iban|ssn)\b/i;
const SECRET_SHAPE_RE = /\b(sk|pk|ghp|gho|xox[abp]|AKIA)[-_a-z0-9]{12,}\b|\b[a-z0-9]{32,}\b|\d{3}-\d{2}-\d{4}\b/i;

/** Credentials and account secrets are never beliefs, whatever the owner said. */
export function looksLikeSecret(text: string): boolean {
  return SECRET_RE.test(text) || SECRET_SHAPE_RE.test(text);
}
