import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BaseChannel } from './base.js';
import type { ChannelMessage } from '../types/channel.js';
import type { MercuryConfig } from '../utils/config.js';
import { logger } from '../utils/logger.js';

interface PendingResponse {
  resolve: (text: string) => void;
  timer: NodeJS.Timeout;
}

interface RateBucket {
  timestamp: number;
  count: number;
}

export class WebPanelChannel extends BaseChannel {
  readonly type = 'web-panel' as const;
  private server: http.Server | null = null;
  private config: MercuryConfig;
  private pending: Map<string, PendingResponse> = new Map();
  private rateLimits: Map<string, RateBucket> = new Map();

  constructor(config: MercuryConfig) {
    super();
    this.config = config;
  }

  async start(): Promise<void> {
    const wp = this.config.channels.webPanel;
    if (!wp || !wp.enabled) {
      logger.info('Web panel disabled — skipping');
      return;
    }

    const host = wp.host || '127.0.0.1';
    const port = wp.port || 3977;

    if ((host === '0.0.0.0' || host === '::') && !wp.authToken && !wp.allowRemote) {
      logger.error('Web panel: refusing to bind 0.0.0.0 without WEB_PANEL_AUTH_TOKEN and WEB_PANEL_ALLOW_REMOTE=true');
      throw new Error('Web panel cannot bind to all interfaces without auth token. Set WEB_PANEL_AUTH_TOKEN or WEB_PANEL_ALLOW_REMOTE=true.');
    }

    if ((host === '0.0.0.0' || host === '::') && !wp.authToken) {
      logger.warn('⚠ Web panel bound to all interfaces WITHOUT authentication. Anyone on your network can access it.');
    }

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, host, () => {
        logger.info({ host, port }, `Web panel listening on http://${host}:${port}`);
        this.ready = true;
        resolve();
      });
      this.server!.on('error', (err) => {
        logger.error({ err }, 'Web panel failed to start');
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.ready = false;
  }

  async send(content: string, targetId?: string, _elapsedMs?: number): Promise<void> {
    if (targetId && this.pending.has(targetId)) {
      const entry = this.pending.get(targetId)!;
      clearTimeout(entry.timer);
      entry.resolve(content);
      this.pending.delete(targetId);
    }
  }

  async sendFile(_filePath: string, _targetId?: string): Promise<void> {}

  async stream(content: AsyncIterable<string>, targetId?: string): Promise<string> {
    let full = '';
    for await (const chunk of content) {
      full += chunk;
    }
    await this.send(full, targetId);
    return full;
  }

  async typing(_targetId?: string): Promise<void> {}

  async askToContinue(_question: string, _targetId?: string): Promise<boolean> {
    return false;
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // Auth check for API routes
    if (pathname.startsWith('/api/')) {
      const wp = this.config.channels.webPanel;
      if (wp?.authToken && !this.checkAuth(req, res, wp.authToken)) {
        return;
      }
    }

    const ip = req.socket.remoteAddress || '127.0.0.1';
    if (!this.checkRateLimit(ip, res)) return;

    if (req.method === 'GET' && pathname === '/') {
      this.serveHtml(res);
      return;
    }

    if (req.method === 'GET' && pathname === '/api/status') {
      this.serveJson(res, this.getStatus());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/help') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Commands: /help /status /budget /tools /skills /memory');
      return;
    }

    if (req.method === 'POST' && pathname === '/api/chat') {
      this.handleChat(req, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/api/command') {
      this.handleCommand(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  private checkAuth(req: IncomingMessage, res: ServerResponse, token: string): boolean {
    const header = (req.headers['authorization'] || '') as string;
    if (header.startsWith('Bearer ') && header.substring(7) === token) {
      return true;
    }
    res.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Bearer' });
    res.end('Unauthorized');
    return false;
  }

  private checkRateLimit(ip: string, res: ServerResponse): boolean {
    const now = Date.now();
    const bucket = this.rateLimits.get(ip);
    if (!bucket || now - bucket.timestamp > 60_000) {
      this.rateLimits.set(ip, { timestamp: now, count: 1 });
      return true;
    }
    bucket.count++;
    if (bucket.count > 60) {
      res.writeHead(429, { 'Content-Type': 'text/plain' });
      res.end('Too many requests');
      return false;
    }
    return true;
  }

  private readBody(req: IncomingMessage, res: ServerResponse, maxBytes: number): Promise<string | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('Payload too large');
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        resolve(Buffer.concat(chunks).toString());
      });
      req.on('error', () => resolve(null));
    });
  }

  private handleChat(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await this.readBody(req, res, 1_000_000);
      if (body === null) return;

      let payload: { message?: string };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const message = payload?.message;
      if (typeof message !== 'string' || !message.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
      }

      const requestId = `webpanel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const channelId = `web-panel:${requestId}`;

      const msg: ChannelMessage = {
        id: requestId,
        channelId,
        channelType: 'web-panel',
        senderId: 'web-user',
        content: message,
        timestamp: Date.now(),
      };

      this.emit(msg);

      try {
        const reply = await new Promise<string>((resolve) => {
          const timer = setTimeout(() => {
            this.pending.delete(channelId);
            resolve('(timeout — no response within 30s)');
          }, 30_000);
          this.pending.set(channelId, { resolve, timer });
        });

        this.serveJson(res, { reply });
      } catch {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal error' }));
      }
    })();
  }

  private handleCommand(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await this.readBody(req, res, 1_000_000);
      if (body === null) return;

      let payload: { command?: string };
      try {
        payload = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const cmd = payload?.command || '';
      const channelId = `web-panel:cmd-${Date.now()}`;

      const msg: ChannelMessage = {
        id: `cmd-${Date.now()}`,
        channelId,
        channelType: 'web-panel',
        senderId: 'web-user',
        content: cmd,
        timestamp: Date.now(),
      };

      this.emit(msg);
      this.serveJson(res, { ok: true });
    })();
  }

  private getStatus(): Record<string, unknown> {
    const wp = this.config.channels.webPanel;
    return {
      name: this.config.identity.name,
      provider: this.config.providers.default,
      tokenBudget: this.config.tokens.dailyBudget,
      telegram: this.config.channels.telegram.enabled,
      webPanel: wp?.enabled ?? false,
      discord: this.config.channels.discord.enabled,
    };
  }

  private serveJson(res: ServerResponse, data: unknown): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private serveHtml(res: ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtmlPage());
  }
}

function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mercury Web Panel</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; }
  .container { max-width: 720px; margin: 0 auto; padding: 16px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; margin-bottom: 12px; }
  h1 { font-size: 1.2rem; color: #58a6ff; margin-bottom: 4px; }
  h2 { font-size: 1rem; color: #8b949e; margin-bottom: 8px; }
  .input-row { display: flex; gap: 8px; }
  .input-row input { flex: 1; padding: 8px 12px; border-radius: 6px; border: 1px solid #30363d; background: #0d1117; color: #c9d1d9; font-size: 14px; outline: none; }
  .input-row input:focus { border-color: #58a6ff; }
  button { padding: 8px 16px; border-radius: 6px; border: none; background: #238636; color: #fff; cursor: pointer; font-size: 14px; white-space: nowrap; }
  button:hover { background: #2ea043; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-row { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
  .btn-sm { padding: 4px 10px; font-size: 12px; background: #30363d; }
  .btn-sm:hover { background: #484f58; }
  #output { white-space: pre-wrap; font-family: 'SF Mono', Consolas, monospace; font-size: 13px; min-height: 200px; max-height: 50vh; overflow-y: auto; padding: 8px; background: #0d1117; border-radius: 6px; border: 1px solid #21262d; margin-top: 8px; }
  .status-row { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: #8b949e; }
  .status-row span { color: #58a6ff; }
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>Mercury Web Panel</h1>
    <div class="status-row" id="status">Loading...</div>
  </div>
  <div class="card">
    <h2>Chat</h2>
    <div class="input-row">
      <input id="msgInput" placeholder="Type a message..." autocomplete="off" />
      <button id="sendBtn">Send</button>
    </div>
    <div class="btn-row">
      <button class="btn-sm" onclick="sendCmd('/help')">Help</button>
      <button class="btn-sm" onclick="sendCmd('/status')">Status</button>
      <button class="btn-sm" onclick="sendCmd('/budget')">Budget</button>
      <button class="btn-sm" onclick="sendCmd('/tools')">Tools</button>
    </div>
    <div id="output"></div>
  </div>
</div>
<script>
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const output = document.getElementById('output');
const statusEl = document.getElementById('status');
let token = '';

// Try to get auth token from prompt if needed
(function checkAuth() {
  const t = localStorage.getItem('mercury_token');
  if (t) token = t;
})();

function getToken() {
  if (!token) {
    const t = prompt('Enter auth token (or leave empty if none):');
    if (t) { token = t; localStorage.setItem('mercury_token', t); }
  }
  return token;
}

function authHeaders() {
  return token ? { 'Authorization': 'Bearer ' + token } : {};
}

async function send(msg) {
  output.textContent += '\\nYou: ' + msg;
  sendBtn.disabled = true;
  try {
    const r = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ message: msg })
    });
    if (r.status === 401) { token = ''; localStorage.removeItem('mercury_token'); output.textContent += '\\nAuth required.'; return; }
    const d = await r.json();
    output.textContent += '\\nMercury: ' + (d.reply || d.error || '(no response)');
  } catch (e) {
    output.textContent += '\\nError: ' + e.message;
  }
  sendBtn.disabled = false;
  output.scrollTop = output.scrollHeight;
}

function sendCmd(cmd) { send(cmd); }

sendBtn.onclick = () => { const v = msgInput.value.trim(); if (!v) return; msgInput.value = ''; send(v); };
msgInput.onkeydown = (e) => { if (e.key === 'Enter') sendBtn.click(); };

// Fetch status on load
fetch('/api/status', { headers: authHeaders() })
  .then(r => r.json())
  .then(d => { statusEl.innerHTML = 'Provider: <span>' + (d.provider||'?') + '</span> · Budget: <span>' + (d.tokenBudget||0) + '</span> · Telegram: <span>' + (d.telegram?'on':'off') + '</span> · Discord: <span>' + (d.discord?'on':'off') + '</span>'; })
  .catch(() => { statusEl.textContent = 'Status unavailable'; });
</script>
</body>
</html>`;
}
