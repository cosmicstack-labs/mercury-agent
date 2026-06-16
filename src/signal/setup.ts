import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { logger } from '../utils/logger.js';
import { ensureSignalCli, findSignalCli, getSignalCliCommand, removeSignalCli, getSignalCliDir, checkJavaAvailable, isNativeAvailable, findJavaPath, getSignalCliExecEnv } from './binary.js';
import { JsonRpcClient } from './jsonrpc.js';
import type { MercuryConfig } from '../utils/config.js';
import { saveConfig, loadConfig, hasSignalAdmins } from '../utils/config.js';
import { redactPhone } from '../utils/redact.js';

export function printQrCode(text: string): void {
  qrcode.generate(text, { small: true });
}

export interface SignalSetupResult {
  success: boolean;
  phoneNumber?: string;
  mode?: string;
  groupId?: string;
  error?: string;
}

export async function checkSignalSetup(config: MercuryConfig): Promise<{
  binaryOk: boolean;
  binaryPath?: string;
  registered: boolean;
  linked: boolean;
  mode: string;
  groupId?: string;
  phoneNumber?: string;
  errors: string[];
}> {
  const errors: string[] = [];
  const result = {
    binaryOk: false as boolean,
    binaryPath: undefined as string | undefined,
    registered: false as boolean,
    linked: false as boolean,
    mode: config.channels.signal.mode || 'group',
    groupId: config.channels.signal.groupId,
    phoneNumber: config.channels.signal.phoneNumber,
    errors,
  };

  try {
    const binaryPath = await ensureSignalCli();
    result.binaryOk = true;
    result.binaryPath = binaryPath;
    logger.info({ path: binaryPath }, 'Signal CLI binary found');
  } catch (err: any) {
    errors.push(`signal-cli not found: ${err.message}`);
    return result;
  }

  if (!config.channels.signal.phoneNumber) {
    errors.push('Signal phone number not configured. Set SIGNAL_PHONE_NUMBER in environment or mercury.yaml');
    return result;
  }

  result.registered = true;

  // Check for local account data — if accounts.json exists with this number,
  // the device has been linked
  const hasLocalData = checkLocalAccountData(config.channels.signal.phoneNumber);
  if (hasLocalData) {
    result.linked = true;
  } else {
    errors.push('Signal device not linked. Run signal setup to link your device.');
  }

  return result;
}

function checkLocalAccountData(phoneNumber: string): boolean {
  const dataDir = process.env.SIGNAL_CLI_CONFIG_DIR || path.join(os.homedir(), '.local', 'share', 'signal-cli');
  const accountsPath = path.join(dataDir, 'data', 'accounts.json');

  if (!fs.existsSync(accountsPath)) return false;

  try {
    const content = fs.readFileSync(accountsPath, 'utf-8');
    const accounts = JSON.parse(content);
    const normalized = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const account = accounts.accounts?.find((a: any) => a.number === normalized);
    if (!account) return false;

    const accountDataPath = path.join(dataDir, 'data', account.path);
    if (fs.existsSync(accountDataPath)) {
      try {
        const accountData = JSON.parse(fs.readFileSync(accountDataPath, 'utf-8'));
        if (accountData.registered === false) {
          logger.info({ phone: redactPhone(phoneNumber) }, 'Signal account found but registered=false, treating as not linked');
          return false;
        }
      } catch { /* ignore parse errors, assume linked */ }
    }

    return true;
  } catch {
    return false;
  }
}

export function deleteSignalCliAccountData(phoneNumber: string): boolean {
  const dataDir = process.env.SIGNAL_CLI_CONFIG_DIR || path.join(os.homedir(), '.local', 'share', 'signal-cli');
  const accountsPath = path.join(dataDir, 'data', 'accounts.json');

  if (!fs.existsSync(accountsPath)) return true;

  try {
    const content = fs.readFileSync(accountsPath, 'utf-8');
    const accounts = JSON.parse(content);
    const normalized = phoneNumber.startsWith('+') ? phoneNumber : `+${phoneNumber}`;
    const account = accounts.accounts?.find((a: any) => a.number === normalized);
    if (!account) return true;

    const accountId = account.path;
    if (accountId) {
      const accountDataFile = path.join(dataDir, 'data', accountId);
      const accountDataDir = path.join(dataDir, 'data', `${accountId}.d`);

      if (fs.existsSync(accountDataFile)) {
        fs.rmSync(accountDataFile, { force: true });
        logger.info({ file: accountDataFile }, 'Deleted signal-cli account data file');
      }
      if (fs.existsSync(accountDataDir)) {
        fs.rmSync(accountDataDir, { recursive: true, force: true });
        logger.info({ dir: accountDataDir }, 'Deleted signal-cli account data directory');
      }
    }

    accounts.accounts = accounts.accounts.filter((a: any) => a.number !== normalized);
    fs.writeFileSync(accountsPath, JSON.stringify(accounts, null, 2));
    logger.info({ phone: redactPhone(phoneNumber) }, 'Removed signal-cli account entry from accounts.json');

    return true;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to delete signal-cli account data');
    return false;
  }
}

export async function verifySignalLinking(phoneNumber: string, binaryPath?: string): Promise<boolean> {
  const binary = binaryPath || await ensureSignalCli();
  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();

  try {
    const result = execSync(
      `${cmd.join(' ')} -u ${phoneNumber} listDevices`,
      { encoding: 'utf-8', timeout: 15000, env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

export async function registerSignalNumber(phoneNumber: string, voice: boolean = false, binaryPath?: string): Promise<{ success: boolean; error?: string }> {
  const binary = binaryPath || await ensureSignalCli();
  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();

  try {
    const args = voice ? '--voice' : '';
    execSync(
      `${cmd.join(' ')} -u ${phoneNumber} register ${args} 2>&1`,
      { encoding: 'utf-8', timeout: 30_000, env },
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function verifySignalNumber(phoneNumber: string, code: string, binaryPath?: string): Promise<{ success: boolean; error?: string }> {
  const binary = binaryPath || await ensureSignalCli();
  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();

  try {
    execSync(
      `${cmd.join(' ')} -u ${phoneNumber} verify ${code} 2>&1`,
      { encoding: 'utf-8', timeout: 15_000, env },
    );
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export interface LinkingSession {
  uri: string;
  process: ChildProcess;
}

export async function startLinking(binaryPath?: string): Promise<LinkingSession | null> {
  const binary = binaryPath || await ensureSignalCli();
  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();

  return new Promise((resolve) => {
    let uri: string | null = null;
    let resolved = false;

    const child = spawn(cmd[0], [...cmd.slice(1), 'link', '-n', 'Mercury'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    };

    const checkForUri = (output: string) => {
      if (!uri && output.startsWith('sgnl://')) {
        uri = output;
        logger.info('Signal device linking URI generated');
        if (!resolved) {
          resolved = true;
          resolve({ uri, process: child });
        }
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      const output = data.toString().trim();
      checkForUri(output);
    });

    child.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug({ stderr: line }, 'signal-cli link stderr');
        checkForUri(line);
      }
    });

    child.on('error', (err) => {
      logger.error({ err: err.message }, 'signal-cli link process error');
      cleanup();
    });

    child.on('exit', (code) => {
      if (!resolved) {
        logger.error({ code }, 'signal-cli link process exited before producing URI');
        cleanup();
      }
    });

    // Timeout: if no URI within 60s, kill and return null
    // Java + signal-cli startup can be slow, especially in Docker
    setTimeout(() => {
      if (!resolved) {
        logger.error('Timed out waiting for signal-cli link URI');
        try { child.kill(); } catch { /* already dead */ }
        cleanup();
      }
    }, 60_000);
  });
}

export async function waitForLinkCompletion(session: LinkingSession, timeoutMs: number = 120_000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
      resolve(result);
    };

    const timer = setTimeout(() => {
      logger.warn('signal-cli link timed out, killing process');
      cleanup(false);
    }, timeoutMs);

    session.process.on('exit', (code) => {
      cleanup(code === 0);
    });

    session.process.on('error', () => {
      cleanup(false);
    });
  });
}

export function cancelLinking(session: LinkingSession): void {
  try { session.process.kill('SIGKILL'); } catch { /* already dead */ }
}

export async function findMercuryGroup(phoneNumber: string, binaryPath?: string): Promise<{ groupId: string; groupName: string } | null> {
  const binary = binaryPath || await ensureSignalCli();
  const rpc = new JsonRpcClient({ binaryPath: binary, phoneNumber });

  try {
    await rpc.start();
    const groups = await rpc.listGroups({ account: phoneNumber }) as any[];
    await rpc.stop();

    if (!Array.isArray(groups)) return null;

    for (const group of groups) {
      const name = (group.name || group.groupName || '').toLowerCase().trim();
      if (name === 'mercury') {
        return {
          groupId: group.groupId || group.id,
          groupName: group.name || group.groupName || 'Mercury',
        };
      }
    }

    return null;
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to list Signal groups');
    try { await rpc.stop(); } catch { /* ignore */ }
    return null;
  }
}

export function completeSignalSetup(
  config: MercuryConfig,
  phoneNumber: string,
  mode: 'private' | 'group',
  groupId?: string,
  groupName?: string,
): SignalSetupResult {
  config.channels.signal.enabled = true;
  config.channels.signal.phoneNumber = phoneNumber;
  config.channels.signal.mode = mode;
  if (groupId) {
    config.channels.signal.groupId = groupId;
    config.channels.signal.groupName = groupName || 'Mercury';
  }
  saveConfig(config);

  logger.info({
    phone: redactPhone(phoneNumber),
    mode,
    groupId: groupId ? redactPhone(groupId) : undefined,
  }, 'Signal setup completed');

  return {
    success: true,
    phoneNumber,
    mode,
    groupId,
  };
}

export function resetSignalSetup(config: MercuryConfig, removeBinary: boolean = false): void {
  config.channels.signal.enabled = false;
  config.channels.signal.phoneNumber = '';
  config.channels.signal.mode = 'group';
  config.channels.signal.groupId = undefined;
  config.channels.signal.groupName = undefined;
  config.channels.signal.admins = [];
  config.channels.signal.members = [];
  config.channels.signal.pending = [];
  saveConfig(config);

  if (removeBinary) {
    removeSignalCli();
  }

  logger.info('Signal setup reset');
}

export function printSetupInstructions(): string {
  return [
    '━━━ Signal Setup Instructions ━━━',
    '',
    '1. Mercury will download signal-cli automatically.',
    '',
    '2. Choose your mode:',
    '   a) Private (Note to Yourself) — 1:1 chat with your own Signal',
    '   b) Group — Create a "Mercury" group in Signal',
    '',
    '3. Link your device:',
    '   a. Open Signal on your phone',
    '   b. Go to Settings > Linked Devices',
    '   c. Tap "+" to add a new device',
    '   d. Scan the QR code shown in the terminal',
    '',
    '4. If using group mode:',
    '   - Create a group named "Mercury" in Signal',
    '   - Add Mercury\'s linked number to the group',
    '   - Send /pair in the group to start pairing',
    '',
    '5. Enter the pairing code shown in the Mercury terminal',
    '',
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

export async function unregisterSignalNumber(phoneNumber: string, binaryPath?: string): Promise<{ success: boolean; error?: string }> {
  const binary = binaryPath || findSignalCli();
  if (!binary) {
    return { success: false, error: 'signal-cli not installed' };
  }
  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();

  try {
    execSync(
      `${cmd.join(' ')} -u ${phoneNumber} unregister 2>&1`,
      { encoding: 'utf-8', timeout: 30_000, env },
    );
    logger.info({ phone: redactPhone(phoneNumber) }, 'Signal number unregistered');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

export async function sendSignalMessage(
  phoneNumber: string,
  message: string,
  target: { groupId?: string; recipient?: string },
  binaryPath?: string,
): Promise<boolean> {
  const binary = binaryPath || findSignalCli();
  if (!binary) return false;

  const cmd = getSignalCliCommand(binary);
  const env = getSignalCliExecEnv();
  const args = [cmd.join(' '), '-u', phoneNumber, 'send'];

  if (target.groupId) {
    args.push('-g', target.groupId);
  } else if (target.recipient) {
    args.push(target.recipient);
  } else {
    return false;
  }

  args.push('-m', `"${message.replace(/"/g, '\\"')}"`);

  try {
    execSync(
      args.join(' ') + ' 2>&1',
      { encoding: 'utf-8', timeout: 15_000, env },
    );
    return true;
  } catch {
    return false;
  }
}

export { ensureSignalCli, findSignalCli, removeSignalCli, getSignalCliDir, checkJavaAvailable, isNativeAvailable, findJavaPath, getSignalCliExecEnv };