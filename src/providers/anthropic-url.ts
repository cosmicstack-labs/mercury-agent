/**
 * The Messages API root for a configured base URL. Config stores the host the
 * way `ANTHROPIC_BASE_URL` is usually written (`https://api.anthropic.com`),
 * while the SDK wants the versioned root it appends `/messages` to, so `/v1`
 * is added unless the URL already ends with it. Empty means the SDK default.
 */
export function anthropicApiRoot(baseUrl: string | undefined): string | undefined {
  const trimmed = (baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return undefined;
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}
