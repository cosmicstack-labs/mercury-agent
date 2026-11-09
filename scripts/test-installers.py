#!/usr/bin/env python3
"""Exercise real installers against disposable local releases; never touch user state.

Run with --shell sh on Linux/macOS, or --shell powershell/pwsh on Windows.
The Windows fixture uses the .NET Framework compiler present on CI runners.
"""
import argparse
import functools
import hashlib
import http.server
import os
from pathlib import Path
import platform
import shlex
import shutil
import subprocess
import tarfile
import tempfile
import threading
import unittest


PARSER = argparse.ArgumentParser()
PARSER.add_argument('--shell', default='sh')
ARGS, UNITTEST_ARGS = PARSER.parse_known_args()
REPO = Path(__file__).resolve().parent.parent
WINDOWS = ARGS.shell != 'sh'


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def guess_type(self, path):
        return 'application/octet-stream'


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='mercury installer ')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / 'releases' / 'v9.9.9'
        self.release.mkdir(parents=True)
        self.prefix = self.root / 'existing installation'
        self.bin = self.prefix / 'bin'
        self.bin.mkdir(parents=True)
        self.name = 'mercury.exe' if WINDOWS else 'mercury'
        self.installed = self.bin / self.name
        self.stub(self.installed, 'old-version')
        (self.bin / 'web').mkdir()
        (self.bin / 'web' / 'index.html').write_text('old-dashboard')
        self.old_binary = self.installed.read_bytes()
        os_name = 'macos' if platform.system() == 'Darwin' else 'linux'
        arch = 'arm64' if platform.machine().lower() in ('arm64', 'aarch64') else 'x64'
        self.asset = 'mercury-win-x64.exe' if WINDOWS else f'mercury-{os_name}-{arch}'
        self.baseline = 'mercury-win-x64-baseline.exe' if WINDOWS else 'mercury-linux-x64-baseline'
        (self.release / 'web').mkdir()
        (self.release / 'web' / 'index.html').write_text('new-dashboard')
        with tarfile.open(self.release / 'web.tar.gz', 'w:gz') as archive:
            archive.add(self.release / 'web', arcname='web')
        handler = functools.partial(QuietHandler, directory=str(self.release.parent))
        server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.shutdown)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith('MERCURY_')}
        self.env.update(MERCURY_VERSION='9.9.9', MERCURY_NO_PATH='1', MERCURY_NO_PAUSE='1',
                        MERCURY_INSTALL=str(self.prefix),
                        MERCURY_DOWNLOAD_BASE=f'http://127.0.0.1:{server.server_port}')
        cpuinfo = self.root / 'cpuinfo'
        cpuinfo.write_text('flags: avx2\n')
        self.env['MERCURY_CPUINFO'] = str(cpuinfo)

    def stub(self, path, version, status=0):
        if WINDOWS:
            source = self.root / 'stub.cs'
            source.write_text('class P { static int Main(string[] a) { '
                              f'System.Console.WriteLine("{version}"); return {status}; }} }}')
            csc = Path(os.environ['WINDIR']) / 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
            subprocess.run([str(csc), '/nologo', '/out:' + str(path), str(source)], check=True,
                           capture_output=True, text=True)
        else:
            path.write_text(f'#!/bin/sh\necho {shlex.quote(version)}\nexit {status}\n')
            path.chmod(0o755)

    def install(self, fail_promotion=False, fail_restore=False):
        assets = sorted(path for path in self.release.iterdir() if path.is_file())
        (self.release / 'checksums.txt').write_text(''.join(
            f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
            for path in assets if path.name != 'checksums.txt'))
        if fail_restore:
            self.env['MERCURY_TEST_RESTORE_FAILURE'] = '1'
        if WINDOWS:
            command = [ARGS.shell, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(REPO / 'scripts/install.ps1')]
            if fail_promotion:
                wrapper = self.root / 'failure.ps1'
                # Fail only the new dashboard's promotion; all actual moves and
                # recovery still use the real filesystem/Move-Item cmdlet.
                wrapper.write_text("""function Move-Item {
    param($Path, $Destination, [switch]$Force)
    if ($Destination -eq (Join-Path $env:MERCURY_INSTALL 'bin/web') -and $Path -notlike '*previous-web') {
        throw 'injected dashboard promotion failure'
    }
    if ($env:MERCURY_TEST_RESTORE_FAILURE -eq '1' -and $Path -like '*previous-binary') {
        throw 'injected binary restoration failure'
    }
    Microsoft.PowerShell.Management\\Move-Item -Path $Path -Destination $Destination -Force:$Force
}
& $env:MERCURY_TEST_INSTALLER
""")
                self.env['MERCURY_TEST_INSTALLER'] = str(REPO / 'scripts/install.ps1')
                command[-1] = str(wrapper)
        else:
            command = ['sh', str(REPO / 'scripts/install.sh')]
            if fail_promotion:
                wrappers = self.root / 'wrappers'
                wrappers.mkdir()
                mv = wrappers / 'mv'
                real_mv = shutil.which('mv')
                mv.write_text(f'''#!/bin/sh
for last do :; done
if [ "$last" = "$MERCURY_INSTALL/bin/web" ] && [ "${{1##*/}}" != previous-web ]; then
  echo 'injected dashboard promotion failure' >&2
  exit 42
fi
if [ "${{MERCURY_TEST_RESTORE_FAILURE:-}}" = 1 ] && [ "${{1##*/}}" = previous-binary ]; then
  echo 'injected binary restoration failure' >&2
  exit 43
fi
exec {shlex.quote(real_mv)} "$@"
''')
                mv.chmod(0o755)
                self.env['PATH'] = str(wrappers) + os.pathsep + self.env['PATH']
        return subprocess.run(command, env=self.env, capture_output=True, text=True, timeout=45)

    def assert_preserved(self, result):
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.installed.read_bytes(), self.old_binary, result.stdout + result.stderr)
        self.assertEqual((self.bin / 'web' / 'index.html').read_text(), 'old-dashboard')

    def test_nonrunnable_update_preserves_working_installation(self):
        self.stub(self.release / self.asset, 'cannot-start', 42)
        self.assert_preserved(self.install())

    def test_failed_baseline_preserves_working_installation(self):
        if not WINDOWS and self.asset != 'mercury-linux-x64':
            self.skipTest('baseline fallback is x64 Linux/Windows only')
        self.stub(self.release / self.asset, 'illegal instruction', -1073741795 if WINDOWS else 132)
        self.stub(self.release / self.baseline, 'baseline-cannot-start', 42)
        result = self.install()
        self.assertIn('switching to the baseline build', result.stdout)
        self.assert_preserved(result)

    def test_dashboard_promotion_failure_restores_both_previous_artifacts(self):
        self.stub(self.release / self.asset, '9.9.9')
        result = self.install(fail_promotion=True)
        self.assertIn('injected dashboard promotion failure', result.stdout + result.stderr)
        self.assert_preserved(result)

    def test_failed_first_install_leaves_no_partial_artifacts(self):
        self.installed.unlink()
        shutil.rmtree(self.bin / 'web')
        self.stub(self.release / self.asset, '9.9.9')
        result = self.install(fail_promotion=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse(self.installed.exists())
        self.assertFalse((self.bin / 'web').exists())
        self.assertEqual(list(self.bin.iterdir()), [])

    def test_failed_recovery_keeps_backup_for_manual_restoration(self):
        self.stub(self.release / self.asset, '9.9.9')
        result = self.install(fail_promotion=True, fail_restore=True)
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('Recovery files:', result.stdout + result.stderr)
        backups = list(self.bin.glob('.mercury-install*/previous-binary'))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), self.old_binary)
        self.assertEqual((self.bin / 'web' / 'index.html').read_text(), 'old-dashboard')

    def test_successful_baseline_is_validated_and_promoted(self):
        if not WINDOWS and self.asset != 'mercury-linux-x64':
            self.skipTest('baseline fallback is x64 Linux/Windows only')
        self.stub(self.release / self.asset, 'illegal instruction', -1073741795 if WINDOWS else 132)
        self.stub(self.release / self.baseline, '9.9.9-baseline')
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('switching to the baseline build', result.stdout)
        self.assertEqual(subprocess.check_output([str(self.installed), '--version'], text=True).strip(), '9.9.9-baseline')
        self.assertEqual((self.bin / 'web' / 'index.html').read_text(), 'new-dashboard')

    def test_successful_update_replaces_both_artifacts(self):
        self.stub(self.release / self.asset, '9.9.9')
        result = self.install()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        actual = subprocess.check_output([str(self.installed), '--version'], text=True).strip()
        self.assertEqual(actual, '9.9.9')
        self.assertEqual((self.bin / 'web' / 'index.html').read_text(), 'new-dashboard')
        self.assertEqual(sorted(path.name for path in self.bin.iterdir()), [self.name, 'web'])


if __name__ == '__main__':
    unittest.main(argv=[__file__] + UNITTEST_ARGS)
