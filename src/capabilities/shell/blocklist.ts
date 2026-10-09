/**
 * Shell command patterns. Matching is a case-insensitive glob over the whole
 * command segment: `*` → any text, `?` → one character, everything else
 * literal (see `globToRegExp` in ../permissions.ts).
 */

function windowsRecursiveDeleteRoots(): string[] {
  const cmdlets = ['Remove-Item', 'rm', 'ri', 'rmdir', 'rd', 'del', 'erase'];
  // Targets: drive root (`C:\`, `C:\*`), home (`~`, `~\`, `~/`), POSIX root.
  const targets = ['?:\\', '?:\\*', '~', '~\\*', '~/*', '/', '/*'];
  const out: string[] = [];
  for (const cmd of cmdlets) {
    for (const target of targets) {
      out.push(`${cmd} -r* ${target}`);            // Remove-Item -Recurse -Force C:\
      out.push(`${cmd} -r* * ${target}`);          // Remove-Item -Recurse -Force -Path C:\
      out.push(`${cmd} ${target} -r*`);            // Remove-Item C:\ -Recurse
      out.push(`${cmd} ${target} * -r*`);          // Remove-Item C:\ -Force -Recurse
      out.push(`${cmd} -Path ${target} -r*`);      // Remove-Item -Path C:\ -Recurse
      out.push(`${cmd} -Path ${target} * -r*`);
    }
  }
  return out;
}

export const BLOCKED_COMMANDS = [
  'sudo *',
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'rm -fr /',
  'rm -fr ~',
  'rm -fr /*',
  'rm -rf .',
  'rm -rf ..',
  'mkfs *',
  'dd if=*',
  'chmod 777 /',
  'chown * /',
  ':(){ :|:& };:',
  'shutdown *',
  'reboot *',
  'halt *',
  'init 0',
  'init 6',
  'kill -9 1',
  '> /dev/sda',
  'mv /* /dev/null',
  // ── Windows / cmd.exe ──
  'del /s /q C:\\*',
  'rmdir /s /q C:\\*',
  'rd /s /q C:\\*',
  'format *',
  'icacls * C:\\* /grant',
  'net user *',
  'netsh *',
  'reg delete *',
  'cmd /c rd /s /q *',
  // ── PowerShell ──
  // Execution-policy changes disable the script-signing guard machine- or
  // user-wide; never something an agent should flip. Covers the bare cmdlet
  // and the `powershell -Command` / `pwsh -c` wrapped forms.
  'Set-ExecutionPolicy *',
  'powershell*Set-ExecutionPolicy *',
  'pwsh*Set-ExecutionPolicy *',
  // Recursive deletes of a drive root, the home directory, or everything, in
  // either argument order. `rm`, `ri`, `rmdir`, `rd`, `del`, `erase` are the
  // PowerShell aliases of Remove-Item; `-r*` also matches `-Recurse`/`-rf`.
  ...windowsRecursiveDeleteRoots(),
];

export const AUTO_APPROVED_COMMANDS = [
  'ls *',
  'cat *',
  'pwd',
  'which *',
  'node *',
  'npm run *',
  'npm test *',
  'npm list *',
  'git status *',
  'git diff *',
  'git log *',
  'git branch *',
  'echo *',
  'head *',
  'tail *',
  'wc *',
  'find *',
  'grep *',
  'rg *',
  'ps *',
  'df *',
  'du *',
  'uname *',
  'dir *',
  'type *',
  'cd *',
  'where *',
  'tree *',
  'findstr *',
  'tasklist *',
  'systeminfo *',
];

export const NEEDS_APPROVAL_COMMANDS = [
  'npm publish *',
  'git push *',
  'docker *',
  'curl * | sh',
  'curl * | bash',
  'wget * | sh',
  'pip install *',
  'pip3 install *',
  'rm -r *',
  'rm -rf *',
  'mv *',
  'cp -r *',
  'chmod *',
  'mkdir *',
  'rmdir *',
  'xcopy *',
  'robocopy *',
  'del *',
  'rd /s *',
  'Remove-Item *',
  'ri *',
  'powershell *',
  'pwsh *',
  'cmd /c *',
];
