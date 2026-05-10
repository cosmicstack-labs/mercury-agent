import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitHubSession {
  accessToken: string;
  tokenType: string;
  scope: string;
  userLogin?: string;
  authenticatedAt: string;
}

/**
 * Copilot-specific token returned by the token exchange endpoint.
 * This is a short-lived token (~30 min) used to call the Copilot API.
 */
export interface CopilotToken {
  token: string;
  expiresAt: number; // unix timestamp (seconds)
  apiEndpoint: string; // e.g. https://api.business.githubcopilot.com
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_OAUTH_CLIENT_ID = 'Iv1.b507a08c87ecfe98';
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_DEVICE_VERIFY_URL = 'https://github.com/login/device';

/** The internal endpoint to exchange a GitHub OAuth token for a Copilot token */
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token';

/** Required headers for Copilot API calls */
export const COPILOT_HEADERS: Record<string, string> = {
  'User-Agent': 'GithubCopilot/1.246.0',
  'Editor-Version': 'vscode/1.96.2',
  'Editor-Plugin-Version': 'copilot-chat/0.24.2',
  'Copilot-Integration-Id': 'vscode-chat',
  'Openai-Intent': 'conversation-panel',
};

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

function getSessionPath(): string {
  return join(getMercuryHome(), 'github-session.json');
}

export function loadGitHubSession(): GitHubSession | null {
  const path = getSessionPath();
  if (!existsSync(path)) return null;

  try {
    const raw = readFileSync(path, 'utf-8');
    const session = JSON.parse(raw) as GitHubSession;
    if (!session.accessToken) return null;
    return session;
  } catch {
    return null;
  }
}

export function saveGitHubSession(session: GitHubSession): void {
  const dir = getMercuryHome();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getSessionPath(), JSON.stringify(session, null, 2), 'utf-8');
}

export function clearGitHubSession(): void {
  const path = getSessionPath();
  if (existsSync(path)) {
    writeFileSync(path, '{}', 'utf-8');
  }
}

// ---------------------------------------------------------------------------
// Token validation
// ---------------------------------------------------------------------------

/**
 * Validate a GitHub OAuth token by calling GET /user.
 * GitHub OAuth tokens don't expire — they're valid until revoked.
 */
export async function validateGitHubToken(accessToken: string): Promise<{
  valid: boolean;
  login?: string;
}> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'mercury-agent/1.0',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) return { valid: false };

    const data = (await response.json()) as Record<string, any>;
    return {
      valid: true,
      login: data.login as string | undefined,
    };
  } catch {
    return { valid: false };
  }
}

/**
 * Check if a session is valid (has a token).
 * GitHub OAuth tokens don't expire, so we just check existence.
 */
export function isGitHubSessionValid(session: GitHubSession | null): boolean {
  return session !== null && session.accessToken.length > 0;
}

// ---------------------------------------------------------------------------
// Copilot token exchange (short-lived tokens for API calls)
// ---------------------------------------------------------------------------

let cachedCopilotToken: CopilotToken | null = null;

/**
 * Exchange a GitHub OAuth token for a short-lived Copilot API token.
 * The Copilot token is cached and auto-refreshed when it expires.
 *
 * Flow:
 * 1. POST to api.github.com/copilot_internal/v2/token with the OAuth token
 * 2. Receive a short-lived token (~30 min) + API endpoint
 * 3. Use the token + endpoint for all Copilot API calls
 */
export async function getCopilotToken(oauthToken: string): Promise<CopilotToken> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedCopilotToken && cachedCopilotToken.expiresAt > Date.now() / 1000 + 60) {
    return cachedCopilotToken;
  }

  const response = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `token ${oauthToken}`,
      Accept: 'application/json',
      'User-Agent': 'mercury-agent/1.0',
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Failed to get Copilot token: ${response.status} — ${text}`);
  }

  const data = (await response.json()) as Record<string, any>;

  if (!data.token) {
    throw new Error('Copilot token exchange returned no token — is GitHub Copilot enabled for your account?');
  }

  cachedCopilotToken = {
    token: data.token as string,
    expiresAt: data.expires_at as number,
    apiEndpoint: (data.endpoints as any)?.api ?? 'https://api.githubcopilot.com',
  };

  return cachedCopilotToken;
}

/**
 * Get a valid Copilot token from the stored GitHub session.
 * Returns null if no session or token exchange fails.
 */
export async function getValidCopilotToken(): Promise<CopilotToken | null> {
  const session = loadGitHubSession();
  if (!isGitHubSessionValid(session)) return null;

  try {
    return await getCopilotToken(session!.accessToken);
  } catch {
    return null;
  }
}

/** Clear the cached copilot token (e.g. on logout) */
export function clearCopilotTokenCache(): void {
  cachedCopilotToken = null;
}
