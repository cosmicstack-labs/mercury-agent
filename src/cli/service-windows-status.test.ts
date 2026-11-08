import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ execFileSync: vi.fn(), execSync: vi.fn(), daemon: vi.fn() }));
vi.mock('node:child_process', async (original) => ({ ...await original<typeof import('node:child_process')>(), execFileSync: mocks.execFileSync, execSync: mocks.execSync }));
vi.mock('./daemon.js', async (original) => ({ ...await original<typeof import('./daemon.js')>(), getDaemonStatus: mocks.daemon }));
import { getWindowsTaskState, isServiceRunning, parseWindowsTaskState, showServiceStatus } from './service.js';

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

  it.each([['0', 'unknown'], ['1', 'disabled'], ['2', 'queued'], ['3', 'ready'], ['4\r\n', 'running']])('decodes numeric state %s as %s', (input, state) => {
    expect(parseWindowsTaskState(input)).toBe(state);
  });

  it.each(['', '5', '-1', '4junk', 'Status: Running', 'Estado: En ejecución', '状態: 実行中', '4\n3'])('refuses nonprotocol output %j', (input) => {
    expect(parseWindowsTaskState(input)).toBeNull();
  });

  it('recognizes running regardless of localized schtasks output, using a bounded fixed-script call', () => {
    mocks.execFileSync.mockReturnValue('4');
    expect(isServiceRunning()).toBe(true);
    const [program, args, options] = mocks.execFileSync.mock.calls[0];
    expect(program).toBe('powershell.exe');
    expect(args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(args[4]).toContain('Schedule.Service');
    expect(args[4]).toContain('GetTask($env:MERCURY_STATUS_TASK_NAME).State');
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000, maxBuffer: 4096, env: { MERCURY_STATUS_TASK_NAME: 'MercuryAgent' } });
    expect(options.shell).toBeUndefined();
    expect(mocks.execSync.mock.calls.some(([command]) => String(command).includes('/fo list'))).toBe(false);
  });

  it('passes task names as data without changing the fixed PowerShell script', () => {
    mocks.execFileSync.mockReturnValue('3');
    getWindowsTaskState("task'; Write-Output stolen; # & %PATH%");
    const [, args, options] = mocks.execFileSync.mock.calls[0];
    expect(args.join(' ')).not.toContain('stolen');
    expect(options.env.MERCURY_STATUS_TASK_NAME).toBe("task'; Write-Output stolen; # & %PATH%");
  });

  it.each(['0', '1', '2', '3', 'Status: Running'])('does not report nonrunning or malformed state %j as running', (state) => {
    mocks.execFileSync.mockReturnValue(state);
    expect(isServiceRunning()).toBe(false);
  });

  it('reports an installed task with unavailable state honestly when the query fails', () => {
    mocks.execFileSync.mockImplementation(() => { throw Object.assign(new Error('localized access denied or timeout'), { code: 'ETIMEDOUT' }); });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(isServiceRunning()).toBe(false);
    showServiceStatus();
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Autostart: Task Scheduler logon task');
    expect(output).toContain('unavailable');
    expect(output).not.toContain('not installed');
  });

  it('retains Run-key daemon liveness without querying Task Scheduler state', () => {
    mocks.execSync.mockImplementation((command: string) => {
      if (command.startsWith('schtasks')) throw new Error('task absent');
      return 'MercuryAgent REG_SZ mercury start';
    });
    mocks.daemon.mockReturnValue({ running: true, pid: 123 });
    expect(isServiceRunning()).toBe(true);
    expect(mocks.execFileSync).not.toHaveBeenCalled();
  });
});
