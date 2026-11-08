import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getWindowsTaskState } from './service.js';

// Runs in the existing Windows CI job. A unique disposable task never
// installs or changes the user's MercuryAgent task and is always removed.
it.skipIf(process.platform !== 'win32')('reads actual Task Scheduler ready/running state through its numeric COM API', async () => {
  const taskName = `MercuryStateTest-${randomUUID()}`;
  const script = (command: string) => execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    env: { ...process.env, MERCURY_STATUS_TASK_NAME: taskName }, encoding: 'utf8', windowsHide: true, timeout: 10_000, stdio: 'pipe',
  });
  const connect = "$ErrorActionPreference='Stop'; $s=New-Object -ComObject Schedule.Service; $s.Connect(); $f=$s.GetFolder('\\');";
  try {
    expect(getWindowsTaskState(taskName)).toBeNull();
    script(connect + "$d=$s.NewTask(0); $d.Settings.ExecutionTimeLimit='PT1M'; $a=$d.Actions.Create(0); $a.Path=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'; $a.Arguments='-NoLogo -NoProfile -NonInteractive -Command \"Start-Sleep -Seconds 30\"'; $null=$f.RegisterTaskDefinition($env:MERCURY_STATUS_TASK_NAME,$d,6,$null,$null,3,$null)");
    expect(getWindowsTaskState(taskName)).toBe('ready');
    script(connect + '$null=$f.GetTask($env:MERCURY_STATUS_TASK_NAME).Run($null)');
    await vi.waitFor(() => expect(getWindowsTaskState(taskName)).toBe('running'), { timeout: 10_000, interval: 250 });
  } finally {
    script(connect + 'foreach ($t in $f.GetTasks(1)) { if ($t.Name -ceq $env:MERCURY_STATUS_TASK_NAME) { try { $t.Stop(0) } finally { $f.DeleteTask($env:MERCURY_STATUS_TASK_NAME,0) } } }');
  }
}, 40_000);
