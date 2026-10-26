export interface RuntimeLog {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface RuntimeDeps {
  mercuryVersion: string;
  dataDir: string;
  /** Resolved settings (defaults filled in, unknown keys dropped). */
  settings: Record<string, unknown>;
  /** Only the secrets the manifest declared, read from ~/.mercury/.env. */
  secrets: Record<string, string | undefined>;
  log: RuntimeLog;
  /** A failure outside a tool call (timer, crash, protocol error). Counts toward the circuit breaker. */
  onError(message: string): void;
  /** The runtime gave up (e.g. crashed too often). The manager disables the plugin. */
  onFatal?(code: 'crashed' | 'activation', message: string): void;
  /** Plugin API 1.1 channels: a `mercury/…` notification from the plugin. */
  onNotification?(method: string, params: unknown): void;
  /** Plugin API 1.1 channels: a `mercury/…` request from the plugin (e.g. a call decision). */
  onRequest?(method: string, params: unknown): Promise<unknown>;
  /** The plugin finished its handshake (first start and every restart). */
  onReady?(): void;
  /** The plugin process went away (crash, recycle or stop). */
  onDown?(): void;
}

export interface PluginRuntime {
  readonly kind: 'in-process' | 'out-of-process';
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
}
