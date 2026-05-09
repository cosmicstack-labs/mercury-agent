import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadGitHubSession,
  saveGitHubSession,
  clearGitHubSession,
  isGitHubSessionValid,
  validateGitHubToken,
  GITHUB_OAUTH_CLIENT_ID,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  GITHUB_DEVICE_VERIFY_URL,
  type GitHubSession,
} from './github-session.js';

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Browser helper
// ---------------------------------------------------------------------------

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'start'
        : 'xdg-open';
  execAsync(`${cmd} "${url}"`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Device flow OAuth
// ---------------------------------------------------------------------------

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/**
 * Step 1: Request device and user verification codes.
 */
async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const response = await fetch(GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: GITHUB_OAUTH_CLIENT_ID,
      scope: '',
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Failed to request device code: ${response.status} — ${text}`);
  }

  return (await response.json()) as DeviceCodeResponse;
}

/**
 * Step 2: Poll for user authorization.
 */
async function pollForToken(
  deviceCode: string,
  interval: number,
  expiresIn: number,
): Promise<{ accessToken: string; tokenType: string; scope: string }> {
  const deadline = Date.now() + expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: GITHUB_OAUTH_CLIENT_ID,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await response.json()) as TokenResponse;

    if (data.access_token) {
      return {
        accessToken: data.access_token,
        tokenType: data.token_type ?? 'bearer',
        scope: data.scope ?? '',
      };
    }

    if (data.error === 'authorization_pending') {
      continue;
    }

    if (data.error === 'slow_down') {
      // GitHub asks us to slow down — add 5 seconds
      pollInterval += 5000;
      continue;
    }

    if (data.error === 'expired_token') {
      throw new Error('Device code expired. Please try again.');
    }

    if (data.error === 'access_denied') {
      throw new Error('Authorization was denied by the user.');
    }

    if (data.error) {
      throw new Error(`GitHub OAuth error: ${data.error} — ${data.error_description || ''}`);
    }
  }

  throw new Error('Authorization timed out. Please try again.');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interactive GitHub OAuth login via device flow.
 *
 * 1. Requests a device code
 * 2. Shows the user code and opens github.com/login/device
 * 3. Polls for authorization
 * 4. Validates the token
 * 5. Stores the session
 */
export async function loginGitHub(): Promise<GitHubSession> {
  console.log(`\n  ${'─'.repeat(54)}`);
  console.log(`  GitHub OAuth Authentication (Device Flow)`);
  console.log(`  ${'─'.repeat(54)}`);
  console.log();

  // Step 1: Get device code
  console.log('  Requesting device code...');
  const device = await requestDeviceCode();

  // Step 2: Show code and open browser
  console.log();
  console.log(`  Your code: ${device.user_code}`);
  console.log();
  console.log(`  Opening: ${device.verification_uri}`);
  console.log(`  Enter the code above in your browser to authorize Mercury.`);
  console.log();
  console.log('  Waiting for authorization (up to 15 minutes)...');

  openBrowser(device.verification_uri);

  // Step 3: Poll
  const tokens = await pollForToken(
    device.device_code,
    device.interval,
    device.expires_in,
  );

  // Step 4: Validate and get user info
  console.log('  Validating token...');
  const validation = await validateGitHubToken(tokens.accessToken);

  // Step 5: Build and save session
  const session: GitHubSession = {
    accessToken: tokens.accessToken,
    tokenType: tokens.tokenType,
    scope: tokens.scope,
    userLogin: validation.login,
    authenticatedAt: new Date().toISOString(),
  };

  saveGitHubSession(session);

  console.log();
  console.log('  GitHub authenticated successfully!');
  if (validation.login) console.log(`  Account: @${validation.login}`);
  console.log(`  Token does not expire (valid until revoked)`);
  console.log(`  ${'─'.repeat(54)}\n`);

  return session;
}

/**
 * Returns the current GitHub session, or null if not authenticated.
 */
export function getGitHubSession(): GitHubSession | null {
  const session = loadGitHubSession();
  if (!isGitHubSessionValid(session)) return null;
  return session;
}

/**
 * Logs out by clearing the stored session.
 */
export function logoutGitHub(): void {
  clearGitHubSession();
}

export { isGitHubSessionValid, loadGitHubSession };
