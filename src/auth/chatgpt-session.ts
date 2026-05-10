import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatGPTSession {
  accessToken: string;
  refreshToken: string;
  /** ISO-8601 timestamp when the access token expires */
  expiresAt: string;
  /** ChatGPT account ID extracted from JWT (needed for API headers) */
  accountId: string;
  userEmail?: string;
  plan?: string;
  authenticatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CHATGPT_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CHATGPT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CHATGPT_DEVICE_AUTH_URL = 'https://auth.openai.com/api/accounts/deviceauth/usercode';
export const CHATGPT_DEVICE_TOKEN_URL = 'https://auth.openai.com/api/accounts/deviceauth/token';
export const CHATGPT_DEVICE_UI_URL = 'https://auth.openai.com/codex/device';
export const CHATGPT_BACKEND_API = 'https://chatgpt.com/backend-api';

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

function getSessionPath(): string {
  return join(getMercuryHome(), 'chatgpt-session.json');
}

export function loadChatGPTSession(): ChatGPTSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const session = JSON.parse(raw) as ChatGPTSession;
    if (!session.accessToken || !session.refreshToken) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveChatGPTSession(session: ChatGPTSession): void {
  const dir = getMercuryHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getSessionPath(), JSON.stringify(session, null, 2), 'utf-8');
}

export function clearChatGPTSession(): void {
  const path = getSessionPath();
  if (existsSync(path)) {
    writeFileSync(path, '{}', 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Token validity
// ---------------------------------------------------------------------------

export function isChatGPTSessionValid(session: ChatGPTSession | null): boolean {
  if (!session || !session.accessToken) return false;
  if (!session.expiresAt) return true;
  // Consider expired 60s early to avoid edge-case failures
  return Date.now() < new Date(session.expiresAt).getTime() - 60_000;
}

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

/**
 * Decode a JWT payload without verifying signature.
 */
export function decodeJwtPayload(token: string): Record<string, any> {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  const payload = parts[1]!;
  // base64url → base64
  const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
  const json = Buffer.from(base64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

/**
 * Extract the ChatGPT account ID from an OAuth access token JWT.
 */
export function extractAccountId(accessToken: string): string {
  try {
    const claims = decodeJwtPayload(accessToken);
    // Try multiple known claim paths
    const authClaim = claims['https://api.openai.com/auth'] as Record<string, any> | undefined;
    if (authClaim?.chatgpt_account_id) return authClaim.chatgpt_account_id;
    if (claims.chatgpt_account_id) return claims.chatgpt_account_id;
    // Fallback: organizations array
    if (Array.isArray(claims.organizations) && claims.organizations[0]?.id) {
      return claims.organizations[0].id;
    }
    throw new Error('Could not find chatgpt_account_id in JWT claims');
  } catch (err: any) {
    throw new Error(`Failed to extract account ID from token: ${err.message}`);
  }
}

/**
 * Extract email from an OAuth access token or id_token JWT.
 */
export function extractEmail(token: string): string | undefined {
  try {
    const claims = decodeJwtPayload(token);
    const profile = claims['https://api.openai.com/profile'] as Record<string, any> | undefined;
    return profile?.email ?? claims.email;
  } catch {
    return undefined;
  }
}

/**
 * Extract plan type from an OAuth access token JWT.
 */
export function extractPlan(token: string): string | undefined {
  try {
    const claims = decodeJwtPayload(token);
    const authClaim = claims['https://api.openai.com/auth'] as Record<string, any> | undefined;
    return authClaim?.chatgpt_plan_type ?? claims.chatgpt_plan_type;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the access token using the stored refresh token.
 * Returns a new session (also saves it), or null on failure.
 */
export async function refreshChatGPTToken(session: ChatGPTSession): Promise<ChatGPTSession | null> {
  try {
    const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: session.refreshToken,
        client_id: CHATGPT_OAUTH_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, any>;
    const accessToken = data.access_token as string;
    const refreshToken = (data.refresh_token as string) || session.refreshToken;
    const expiresIn = (data.expires_in as number) || 3600;

    const accountId = extractAccountId(accessToken);
    const email = extractEmail(accessToken);
    const plan = extractPlan(accessToken);

    const newSession: ChatGPTSession = {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      accountId,
      userEmail: email ?? session.userEmail,
      plan: plan ?? session.plan,
      authenticatedAt: session.authenticatedAt,
    };

    saveChatGPTSession(newSession);
    return newSession;
  } catch {
    return null;
  }
}

/**
 * Get a valid session, refreshing the token if needed.
 * Returns null if no session exists or refresh fails.
 */
export async function getValidChatGPTSession(): Promise<ChatGPTSession | null> {
  const session = loadChatGPTSession();
  if (!session) return null;

  if (isChatGPTSessionValid(session)) return session;

  // Try refreshing
  if (session.refreshToken) {
    return refreshChatGPTToken(session);
  }

  return null;
}
