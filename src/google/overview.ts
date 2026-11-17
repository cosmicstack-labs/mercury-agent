import type { SecurityFinding } from '../security/check.js';
import type { FoundGws, findGws } from './gws-binary.js';
import { isReadOnly, type GoogleStatus, type googleLogout, type googleStatus, type gwsVersion } from './connect.js';

export const GOOGLE_PERMISSIONS_URL = 'https://myaccount.google.com/permissions';

export interface GoogleOverviewDeps {
  findGws: typeof findGws;
  googleStatus: typeof googleStatus;
  findings: () => SecurityFinding[];
  gwsVersion?: typeof gwsVersion;
}

export interface GoogleOverview {
  gws: FoundGws | null;
  version: string | null;
  status: GoogleStatus | null;
  error: string | null;
  findings: SecurityFinding[];
}

export type GoogleDisconnect =
  | { kind: 'not-installed' }
  | { kind: 'signed-out'; removed: number }
  | { kind: 'failed'; error: string };

export function accessLabel(scopes: string[]): 'read-only' | 'read and write' {
  return isReadOnly(scopes) ? 'read-only' : 'read and write';
}

export async function googleOverview(deps: GoogleOverviewDeps): Promise<GoogleOverview> {
  const gws = deps.findGws();
  if (!gws) return { gws: null, version: null, status: null, error: null, findings: [] };
  const [version, status] = await Promise.all([
    deps.gwsVersion ? deps.gwsVersion(gws.path).catch(() => null) : Promise.resolve(null),
    deps.googleStatus(gws.path).then(
      (current) => ({ current, error: null }),
      (err: Error) => ({ current: null, error: err.message }),
    ),
  ]);
  return { gws, version, status: status.current, error: status.error, findings: deps.findings() };
}

export async function disconnectGoogle(deps: { findGws: typeof findGws; googleLogout: typeof googleLogout }): Promise<GoogleDisconnect> {
  const gws = deps.findGws();
  if (!gws) return { kind: 'not-installed' };
  try {
    const { removed } = await deps.googleLogout(gws.path);
    return { kind: 'signed-out', removed };
  } catch (err) {
    return { kind: 'failed', error: (err as Error).message };
  }
}
