import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn(), daemon: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFileSync: mocks.execFileSync, execSync: mocks.execSync }));
vi.mock('./daemon.js', async (original) => ({ ...await original<typeof import('./daemon.js')>(), getDaemonStatus: mocks.daemon }));
import { getWindowsServiceMode, getWindowsTaskState, isServiceInstalled, isServiceRunning, parseWindowsTaskState, showServiceStatus, stopService } from './service.js';

const failures = [
  ['access denied', Object.assign(new Error('Acceso denegado'), { status: 1 })],
  ['missing PowerShell', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' })],
  ['COM unavailable', Object.assign(new Error('COM service unavailable'), { status: 1 })],
  ['timeout', Object.assign(new Error('query timed out'), { code: 'ETIMEDOUT' })],
] as const;

describe('Windows service status independent of display language', () => {
  const platform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    mocks.execFileSync.mockReset(); mocks.execSync.mockReset(); mocks.daemon.mockReset();
    mocks.execSync.mockReturnValue('Estado: En ejecución\r\nStatus: Wird ausgeführt\r\n状態: 実行中');
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.restoreAllMocks();
  });

  it.each([['0', 'unknown'], ['1', 'disabled'], ['2', 'queued'], ['3', 'ready'], ['4\r\n', 'running'], ['missing', 'missing']])('decodes protocol state %s as %s', (input, state) => {
    expect(parseWindowsTaskState(input)).toBe(state);
  });

  it.each(['', '5', '-1', '4junk', 'Status: Running', 'Estado: En ejecución', '状態: 実行中', '4\n3', 'missing\n4'])('refuses nonprotocol output %j', (input) => {
    expect(parseWindowsTaskState(input)).toBeNull();
  });

  it('recognizes running using one bounded fixed-script call, with no localized existence probe', () => {
    mocks.execFileSync.mockReturnValue('4');
    expect(isServiceRunning()).toBe(true);
    const [program, args, options] = mocks.execFileSync.mock.calls[0];
    expect(program).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(args[4]).toContain('Schedule.Service');
    expect(args[4]).toContain('GetTask($env:MERCURY_STATUS_TASK_NAME)');
    expect(args[4]).toContain('[int]$task.State');
    expect(args[4]).toContain('$exception.HResult -eq -2147024894');
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { MERCURY_STATUS_TASK_NAME: 'MercuryAgent' } });
    expect(options.shell).toBeUndefined();
    expect(mocks.execFileSync).toHaveBeenCalledTimes(1);
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it('passes task names as data without changing the fixed PowerShell script', () => {
    mocks.execFileSync.mockReturnValue('3');
    getWindowsTaskState("task'; Write-Output stolen; # & %PATH%");
    const [, args, options] = mocks.execFileSync.mock.calls[0];
    expect(args.join(' ')).not.toContain('stolen');
    expect(options.env.MERCURY_STATUS_TASK_NAME).toBe("task'; Write-Output stolen; # & %PATH%");
  });

  it.each(['1', '2', '3'])('does not report nonrunning state %j as running', (state) => {
    mocks.execFileSync.mockReturnValue(state);
    expect(isServiceInstalled()).toBe(true);
    expect(isServiceRunning()).toBe(false);
  });

  it.each(failures)('preserves unavailable status on %s rather than claiming absence or a successful stop', (_label, error) => {
    mocks.execFileSync.mockImplementation(() => { throw error; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(getWindowsTaskState()).toBeNull();
    expect(() => isServiceInstalled()).toThrow('unavailable');
    expect(() => isServiceRunning()).toThrow('unavailable');
    expect(() => getWindowsServiceMode()).toThrow('unavailable');
    expect(stopService()).toBe(false);
    showServiceStatus();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('unavailable');
    expect(output).not.toContain('not installed');
    expect(mocks.execSync).not.toHaveBeenCalled();
    expect(mocks.execFileSync.mock.calls.every(([program]) => program === 'powershell.exe')).toBe(true);
  });

  it.each(['', '4junk', 'Status: Running', '4\n3'])('preserves unavailable status for malformed query output %j', (state) => {
    mocks.execFileSync.mockReturnValue(state);
    expect(() => isServiceInstalled()).toThrow('unavailable');
    expect(() => isServiceRunning()).toThrow('unavailable');
    expect(stopService()).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    showServiceStatus();
    expect(log.mock.calls.flat().join('\n')).toContain('unavailable');
  });

  it('does not equate the numeric unknown state with stopped', () => {
    mocks.execFileSync.mockReturnValue('0');
    expect(isServiceInstalled()).toBe(true);
    expect(() => isServiceRunning()).toThrow('unknown');
    expect(stopService()).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    showServiceStatus();
    expect(log.mock.calls.flat().join('\n')).toContain('unknown');
  });

  it('only reports not installed when the task and Run entry are absent', () => {
    mocks.execFileSync.mockReturnValue('missing');
    mocks.execSync.mockImplementation(() => { throw new Error('Run entry absent'); });
    expect(isServiceInstalled()).toBe(false);
    expect(isServiceRunning()).toBe(false);
    expect(stopService()).toBe(true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    showServiceStatus();
    expect(log.mock.calls.flat().join('\n')).toContain('not installed');
  });

  it('retains Run-key daemon liveness only after confirming the task is absent', () => {
    mocks.execFileSync.mockReturnValue('missing');
    mocks.daemon.mockReturnValue({ running: true, pid: 123 });
    expect(getWindowsServiceMode()).toBe('run-key');
    expect(isServiceRunning()).toBe(true);
    expect(mocks.execSync.mock.calls.every(([command]) => String(command).startsWith('reg query'))).toBe(true);
  });

  it.each(failures)('does not report success if the stop command fails with %s', (_label, error) => {
    mocks.execFileSync.mockImplementation((program: string) => {
      if (program === 'powershell.exe') return '4';
      throw error;
    });
    expect(stopService()).toBe(false);
    expect(mocks.execFileSync).toHaveBeenCalledWith('schtasks.exe', ['/end', '/tn', 'MercuryAgent'], {
      stdio: 'pipe', windowsHide: true, timeout: 5000,
    });
  });

  it.each(['0', 'invalid', ...failures.map(([, error]) => error)])('does not report success if status becomes unavailable after stopping: %s', (result) => {
    let queries = 0;
    mocks.execFileSync.mockImplementation((program: string) => {
      if (program !== 'powershell.exe') return '';
      if (queries++ === 0) return '4';
      if (result instanceof Error) throw result;
      return result;
    });
    expect(stopService()).toBe(false);
  });

  it.each(['1', '3', 'missing'])('confirms a successful stop only for a known inactive state %s', (result) => {
    let queries = 0;
    mocks.execFileSync.mockImplementation((program: string) => program !== 'powershell.exe' ? '' : queries++ === 0 ? '4' : result);
    expect(stopService()).toBe(true);
  });

  it.each(['2', '4'])('times out rather than treating persistent state %s as stopped', (result) => {
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(Atomics, 'wait').mockImplementation(() => { now += 1000; return 'timed-out'; });
    mocks.execFileSync.mockImplementation((program: string) => program === 'powershell.exe' ? result : '');
    expect(stopService()).toBe(false);
    expect(now).toBe(5000);
  });
});
