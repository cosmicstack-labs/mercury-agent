/**
 * AI/ML API attributes traffic by header. A request without them is served
 * normally and simply counts for nobody, so a missing or misspelled value
 * fails silently — which is why the host check below is exact and why the
 * tests cover the near-misses rather than only the hit.
 *
 * `X-AIMLAPI-Partner-ID` must match `^part_[A-Za-z0-9]{1,64}$`: alphanumerics
 * only after the prefix. `HTTP-Referer` and `X-Title` are the OpenRouter
 * convention that most gateways already understand.
 */
export const AIMLAPI_HOST = 'api.aimlapi.com';
export const AIMLAPI_BASE_URL = `https://${AIMLAPI_HOST}/v1`;

const PARTNER_ID = 'part_nl32eeP4aNn6xzoF09Cn2SOQ';
const SOURCE = 'agent/mercury-agent';
const REFERER = 'https://github.com/cosmicstack-labs/mercury-agent';
const TITLE = 'Mercury Agent';

/**
 * Parse the URL and compare the host, rather than matching a prefix.
 *
 * The failure a substring check invites is one-directional and expensive:
 * `https://api.aimlapi.com.example.test/v1` is a different origin, and sending
 * a partner id there hands our attribution to whoever owns it. A user is free
 * to point `openaiCompat` anywhere, so this runs on untrusted input.
 */
export function isAimlapiBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  return url.hostname.toLowerCase() === AIMLAPI_HOST;
}

/** Attribution headers for AI/ML API, or `undefined` for every other host. */
export function aimlapiHeaders(baseUrl: string): Record<string, string> | undefined {
  if (!isAimlapiBaseUrl(baseUrl)) return undefined;
  return {
    'X-AIMLAPI-Partner-ID': PARTNER_ID,
    'X-AIMLAPI-Source': SOURCE,
    'HTTP-Referer': REFERER,
    'X-Title': TITLE,
  };
}
