// Temporary CI startup diagnostic: blank page only, production network guard,
// no credential inheritance, no debug listener and no sandbox override.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, win32 } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { browserArgs, browserEnvironment, findBrowser } from '../src/capabilities/browser/launch.js';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function systemEnv(): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'CommonProgramFiles', 'CommonProgramFiles(x86)', 'CommonProgramW6432']) {
    const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
    if (entry?.[1]) selected[name] = entry[1];
  }
  const root = selected.SystemRoot ?? selected.WINDIR;
  if (root) selected.PATH = win32.join(root, 'System32');
  return selected;
}
function exited(child: ChildProcess): boolean { return !child.pid || child.exitCode !== null || child.signalCode !== null; }

async function probe(addSystemDirectories: boolean): Promise<void> {
  const executable = await findBrowser();
  const profile = await mkdtemp(join(tmpdir(), 'mercury-browser-probe-'));
  const proxy = createServer((_req, res) => { res.writeHead(403, { Connection: 'close' }).end(); });
  proxy.on('connect', (_req, socket) => socket.destroy());
  proxy.on('upgrade', (_req, socket) => socket.destroy());
  let child: ChildProcess | undefined;
  let stderr = '';
  let failure = '';
  const replies: Array<{ id: number; ms: number; result?: unknown; error?: unknown }> = [];
  const started = Date.now();
  try {
    await mkdir(join(profile, 'Default'));
    await writeFile(join(profile, 'Default', 'Preferences'), JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false, default_content_setting_values: { javascript: 2, notifications: 2, geolocation: 2, media_stream_mic: 2, media_stream_camera: 2, automatic_downloads: 2 } }, autofill: { profile_enabled: false, credit_card_enabled: false } }));
    await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('proxy unavailable');
    const env = { ...(addSystemDirectories ? systemEnv() : {}), ...browserEnvironment(profile) };
    child = spawn(executable, [...browserArgs(profile, address.port), '--enable-logging=stderr'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'], env, windowsHide: true, detached: process.platform !== 'win32' });
    child.stdout?.resume();
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(0, 8192); });
    child.on('error', error => { failure = error.message; });
    let buffer = '';
    const output = child.stdio[4] as Readable;
    output.setEncoding('utf8');
    output.on('error', error => { failure = error.message; });
    (child.stdio[3] as Writable).on('error', error => { failure = error.message; });
    output.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 1_000_000) { failure = 'protocol limit exceeded'; buffer = ''; return; }
      let at: number;
      while ((at = buffer.indexOf('\0')) >= 0) {
        const raw = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        try { const reply = JSON.parse(raw); if (reply.id) replies.push({ id: reply.id, ms: Date.now() - started, result: reply.result, error: reply.error }); }
        catch { failure = 'invalid protocol JSON'; }
      }
    });
    (child.stdio[3] as Writable).write(JSON.stringify({ id: 1, method: 'Browser.getVersion' }) + '\0');
    (child.stdio[3] as Writable).write(JSON.stringify({ id: 2, method: 'Target.getTargets' }) + '\0');
    while (Date.now() - started < 30_000 && replies.length < 2 && !failure && !exited(child)) await pause(100);
    console.log(JSON.stringify({ probe: addSystemDirectories ? 'system-directory-env' : 'production-env', executable: basename(executable), platform: process.platform, runtime: process.version, envKeys: Object.keys(env).sort(), elapsedMs: Date.now() - started, exitCode: child.exitCode, signalCode: child.signalCode, failure, replies, stderr: stderr.split(profile).join('<profile>') }));
  } finally {
    if (child && !exited(child)) {
      (child.stdio[3] as Writable).write(JSON.stringify({ id: 3, method: 'Browser.close' }) + '\0');
      await pause(1000);
      if (!exited(child)) {
        if (process.platform === 'win32') {
          const root = systemEnv().SystemRoot ?? systemEnv().WINDIR;
          if (!root) throw new Error('Cannot safely resolve taskkill');
          const killer = spawn(win32.join(root, 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          await Promise.race([new Promise<void>(resolve => { killer.once('exit', () => resolve()); killer.once('error', () => resolve()); }), pause(3000)]);
        } else { try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
        for (let i = 0; i < 30 && !exited(child); i++) await pause(100);
        if (!exited(child)) throw new Error('Browser probe could not confirm process exit');
      }
    }
    proxy.closeAllConnections();
    await new Promise<void>(resolve => proxy.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

await probe(false);
if (process.platform === 'win32') await probe(true);
