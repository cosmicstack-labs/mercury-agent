import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import {
  loadChatGPTSession,
  saveChatGPTSession,
  clearChatGPTSession,
  isChatGPTSessionValid,
  getValidChatGPTSession,
  extractAccountId,
  extractEmail,
  extractPlan,
  CHATGPT_OAUTH_CLIENT_ID,
  CHATGPT_OAUTH_TOKEN_URL,
  CHATGPT_DEVICE_AUTH_URL,
  CHATGPT_DEVICE_TOKEN_URL,
  CHATGPT_DEVICE_UI_URL,
  type ChatGPTSession,
} from './chatgpt-session.js';

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
// Device-flow OAuth
// ---------------------------------------------------------------------------

interface DeviceAuthResponse {
  device_auth_id: string;
  user_code: string;
  interval: number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  error?: string;
}

/**
 * Step 1: Request a device code from OpenAI.
 */
async function requestDeviceCode(): Promise<DeviceAuthResponse> {
  const response = await fetch(CHATGPT_DEVICE_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CHATGPT_OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Failed to request device code: ${response.status} — ${text}`);
  }

  return (await response.json()) as DeviceAuthResponse;
}

/**
 * Step 2: Poll for user authorization.
 */
async function pollForAuthorization(
  deviceAuthId: string,
  userCode: string,
  interval: number,
  timeoutMs = 300_000, // 5 minutes
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  const deadline = Date.now() + timeoutMs;
  const pollInterval = (interval + 3) * 1000; // interval + safety margin

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    const response = await fetch(CHATGPT_DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceAuthId,
        user_code: userCode,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) continue;

    const data = (await response.json()) as DeviceTokenResponse;

    if (data.authorization_code && data.code_verifier) {
      return {
        authorizationCode: data.authorization_code,
        codeVerifier: data.code_verifier,
      };
    }

    if (data.error && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
      throw new Error(`Device authorization failed: ${data.error}`);
    }
  }

  throw new Error('Device authorization timed out (5 minutes). Please try again.');
}

/**
 * Step 3: Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  authorizationCode: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
  const response = await fetch(CHATGPT_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code: authorizationCode,
      redirect_uri: 'https://auth.openai.com/deviceauth/callback',
      client_id: CHATGPT_OAUTH_CLIENT_ID,
      code_verifier: codeVerifier,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown');
    throw new Error(`Token exchange failed: ${response.status} — ${text}`);
  }

  const data = (await response.json()) as Record<string, any>;

  if (!data.access_token) {
    throw new Error('Token exchange response missing access_token');
  }

  return {
    accessToken: data.access_token as string,
    refreshToken: data.refresh_token as string,
    expiresIn: (data.expires_in as number) || 3600,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Interactive ChatGPT OAuth login via device flow.
 *
 * 1. Requests a device code from OpenAI
 * 2. Shows the user code and opens the browser
 * 3. Polls for authorization
 * 4. Exchanges the code for tokens
 * 5. Stores the session
 */
export async function loginChatGPT(): Promise<ChatGPTSession> {
  console.log(`\n  ${'─'.repeat(54)}`);
  console.log(`  ChatGPT OAuth Authentication (Device Flow)`);
  console.log(`  ${'─'.repeat(54)}`);
  console.log();

  // Step 1: Get device code
  console.log('  Requesting device code...');
  const device = await requestDeviceCode();

  // Step 2: Show code and open browser
  console.log();
  console.log(`  Your code: ${device.user_code}`);
  console.log();
  console.log(`  Opening: ${CHATGPT_DEVICE_UI_URL}`);
  console.log(`  Enter the code above in your browser to authorize Mercury.`);
  console.log();
  console.log('  Waiting for authorization (up to 5 minutes)...');

  openBrowser(CHATGPT_DEVICE_UI_URL);

  // Step 3: Poll
  const { authorizationCode, codeVerifier } = await pollForAuthorization(
    device.device_auth_id,
    device.user_code,
    device.interval,
  );

  // Step 4: Exchange for tokens
  console.log('  Exchanging code for tokens...');
  const tokens = await exchangeCodeForTokens(authorizationCode, codeVerifier);

  // Step 5: Build and save session
  const accountId = extractAccountId(tokens.accessToken);
  const email = extractEmail(tokens.accessToken);
  const plan = extractPlan(tokens.accessToken);

  const session: ChatGPTSession = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
    accountId,
    userEmail: email,
    plan: plan ?? 'unknown',
    authenticatedAt: new Date().toISOString(),
  };

  saveChatGPTSession(session);

  console.log();
  console.log('  ChatGPT authenticated successfully!');
  if (email) console.log(`  Account: ${email}`);
  if (plan) console.log(`  Plan: ${plan}`);
  console.log(`  Token expires in: ~${Math.round(tokens.expiresIn / 60)} minutes (auto-refreshes)`);
  console.log(`  ${'─'.repeat(54)}\n`);

  return session;
}

/**
 * Returns a valid ChatGPT session, refreshing if needed.
 * Synchronous check only — for async refresh use getValidChatGPTSession().
 */
export function getChatGPTSession(): ChatGPTSession | null {
  const session = loadChatGPTSession();
  if (!isChatGPTSessionValid(session)) return null;
  return session;
}

/**
 * Logs out of ChatGPT by clearing the stored session.
 */
export function logoutChatGPT(): void {
  clearChatGPTSession();
}

export { isChatGPTSessionValid, loadChatGPTSession, getValidChatGPTSession };
