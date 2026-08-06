import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { logger } from '../utils/logger.js';
import { getSignalCliCommand, getSignalCliExecEnv } from './binary.js';
import type { JsonRpcEnvelope } from './process.js';

export function killStaleSignalCliProcesses(): void {
  try {
    const result = execSync('pgrep -f "org.asamk.signal.Main"', { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (!result) return;
    const pids = result.split('\n').map(p => p.trim()).filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
        logger.info({ pid }, 'Killed stale signal-cli process');
      } catch { /* already dead */ }
    }
  } catch { /* no processes found */ }
}

export interface JsonRpcClientOptions {
  binaryPath: string;
  phoneNumber: string;
  configDir?: string;
}

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timeout: NodeJS.Timeout;
};

type EnvelopeHandler = (envelope: JsonRpcEnvelope) => void;

let requestId = 0;

const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 60000;
const RECONNECT_MULTIPLIER = 1.5;
const STARTUP_TIMEOUT = 60_000;

export class JsonRpcClient {
  private process: ChildProcess | null = null;
  private pending = new Map<number, PendingRequest>();
  private envelopeHandler?: EnvelopeHandler;
  private running = false;
  private readline: ReturnType<typeof createInterface> | null = null;
  private requestTimeout: number;
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private options: JsonRpcClientOptions,
    requestTimeoutMs: number = 30_000,
  ) {
    this.requestTimeout = requestTimeoutMs;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.envelopeHandler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;

    this.shouldReconnect = true;
    await this.spawnProcess();
  }

  private async spawnProcess(): Promise<void> {
    killStaleSignalCliProcesses();

    const cmd = getSignalCliCommand(this.options.binaryPath);
    const args = [...cmd.slice(1), '-u', this.options.phoneNumber, 'jsonRpc', '--receive-mode', 'on-start'];

    if (this.options.configDir) {
      args.unshift('--config', this.options.configDir);
    }

    const env = getSignalCliExecEnv();
    if (this.options.configDir) {
      env.SIGNAL_CLI_CONFIG_DIR = this.options.configDir;
    }

    logger.info({ cmd: cmd[0], phone: this.options.phoneNumber.slice(0, 6) + '***' }, 'Starting signal-cli JSON-RPC daemon');

    this.process = spawn(cmd[0], args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.on('error', (err) => {
      logger.error({ err: err.message }, 'signal-cli JSON-RPC process error');
      this.handleProcessExit();
    });

    this.process.on('exit', (code, signal) => {
      logger.warn({ code, signal }, 'signal-cli JSON-RPC process exited');
      this.handleProcessExit();
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) {
        logger.debug({ stderr: line }, 'signal-cli stderr');
      }
    });

    this.readline = createInterface({ input: this.process.stdout! });
    this.readline.on('line', (line) => {
      this.handleLine(line);
    });

    await this.waitForReady();

    this.running = true;
    this.reconnectAttempts = 0;
    logger.info('signal-cli JSON-RPC daemon connected');
  }

  private async waitForReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timed out waiting for signal-cli daemon to start'));
      }, STARTUP_TIMEOUT);

      let resolved = false;

      const checkReady = async () => {
        try {
          await this.send('version', {});
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            resolve();
          }
        } catch {
          if (!resolved && this.shouldReconnect) {
            setTimeout(checkReady, 1000);
          }
        }
      };

      setTimeout(checkReady, 500);
    });
  }

  private handleProcessExit(): void {
    this.running = false;
    this.process = null;

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('signal-cli process exited'));
    }
    this.pending.clear();

    if (this.shouldReconnect) {
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      BASE_RECONNECT_DELAY * Math.pow(RECONNECT_MULTIPLIER, this.reconnectAttempts),
      MAX_RECONNECT_DELAY,
    );
    this.reconnectAttempts++;

    if (this.reconnectAttempts > 50) {
      logger.error('Max reconnect attempts (50) reached for signal-cli daemon');
      return;
    }

    if (this.reconnectAttempts > 20) {
      logger.warn({ attempt: this.reconnectAttempts, delay: Math.round(delay) }, 'signal-cli reconnecting (throttled)');
    } else {
      logger.info({ attempt: this.reconnectAttempts, delay: Math.round(delay) }, 'signal-cli reconnecting');
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.spawnProcess();
      } catch (err: any) {
        logger.error({ err: err.message }, 'Failed to reconnect signal-cli daemon');
      }
    }, delay);
  }

  async send(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.process || this.process.exitCode !== null) {
      throw new Error('signal-cli JSON-RPC client not running');
    }

    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      method,
      params,
      id,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC request timed out: ${method}`));
      }, this.requestTimeout);

      this.pending.set(id, { resolve, reject, timeout });

      const line = JSON.stringify(request) + '\n';
      try {
        this.process!.stdin!.write(line);
      } catch (err: any) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new Error(`Failed to write to signal-cli stdin: ${err.message}`));
      }
    });
  }

  async sendMessage(params: {
    account: string;
    message: string;
    recipients?: string[];
    groupId?: string;
    attachments?: string[];
  }): Promise<unknown> {
    const sendParams: Record<string, unknown> = {
      account: params.account,
      message: params.message,
    };

    if (params.recipients && params.recipients.length > 0) {
      sendParams.recipients = params.recipients;
    }
    if (params.groupId) {
      sendParams.groupId = params.groupId;
    }
    if (params.attachments && params.attachments.length > 0) {
      sendParams.attachments = params.attachments;
    }

    return this.send('send', sendParams);
  }

  async sendTyping(params: { account: string; recipient?: string; groupId?: string }): Promise<unknown> {
    return this.send('sendTyping', params as Record<string, unknown>);
  }

  async listGroups(params: { account: string }): Promise<unknown> {
    return this.send('listGroups', params as Record<string, unknown>);
  }

  async listContacts(params: { account: string }): Promise<unknown> {
    return this.send('listContacts', params as Record<string, unknown>);
  }

  async getProfile(params: { account: string; recipient?: string; profileName?: string }): Promise<unknown> {
    return this.send('getProfile', params as Record<string, unknown>);
  }

  async register(params: { account: string; voice?: boolean }): Promise<unknown> {
    return this.send('register', params as Record<string, unknown>);
  }

  async verify(params: { account: string; code: string }): Promise<unknown> {
    return this.send('verify', params as Record<string, unknown>);
  }

  async stop(): Promise<void> {
    this.shouldReconnect = false;
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Client stopped'));
    }
    this.pending.clear();

    if (this.process) {
      try {
        this.process.kill('SIGTERM');
      } catch { /* already dead */ }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          try { this.process?.kill('SIGKILL'); } catch { /* already dead */ }
          resolve();
        }, 3000);

        this.process!.on('exit', () => {
          clearTimeout(timeout);
          resolve();
        });

        if (this.process!.exitCode !== null) {
          clearTimeout(timeout);
          resolve();
        }
      });

      this.process = null;
    }
  }

  isRunning(): boolean {
    return this.running && this.process !== null && this.process.exitCode === null;
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;

    try {
      const parsed = JSON.parse(line);

      if (parsed.error && parsed.id) {
        const id = parsed.id;
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.reject(new Error(parsed.error.message || `JSON-RPC error ${parsed.error.code}`));
        } else {
          logger.warn({ id, error: parsed.error.message }, 'Received JSON-RPC error for unknown request');
        }
        return;
      }

      if (parsed.id != null && parsed.result !== undefined) {
        const id = parsed.id;
        const pending = this.pending.get(id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(id);
          pending.resolve(parsed.result);
        } else {
          logger.debug({ id }, 'Received JSON-RPC result for unknown request');
        }
        return;
      }

      if (parsed.method === 'receive' && parsed.params?.envelope) {
        logger.info({ source: parsed.params.envelope.source, hasData: !!parsed.params.envelope.dataMessage }, 'Signal: received envelope from signal-cli');
        try {
          const envelope = parsed.params.envelope as JsonRpcEnvelope;
          this.envelopeHandler?.(envelope);
        } catch (err: any) {
          logger.error({ err: err.message }, 'Error handling signal-cli envelope');
        }
      } else if (parsed.method) {
        logger.debug({ method: parsed.method }, 'Received JSON-RPC notification with unknown method');
      }
    } catch {
      logger.debug({ line: line.slice(0, 200) }, 'Non-JSON line from signal-cli');
    }
  }
}