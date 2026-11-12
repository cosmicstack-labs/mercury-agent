import { describe, expect, it } from 'vitest';
import { isReadOnlySegment, shellPaths, shellWords, stripHeredocs } from './shell-paths.js';
import { splitShellSegments } from './permissions.js';

const all = (cmd: string) => splitShellSegments(stripHeredocs(cmd)).flatMap((s) => shellPaths(s));

describe('the files a command touches (from real bot questions that were false alarms)', () => {
  it('a heredoc body is data: no "/", "/*" or "/\\s+" files', () => {
    const cmd = "cat > /bots/me/sandbox/load-data.js << 'ENDJS'\n// Load and transform project data\n/* block */\nconst re = /\\s+/g;\nENDJS";
    expect(all(cmd)).toEqual([{ path: '/bots/me/sandbox/load-data.js', mode: 'write' }]);
  });

  it('a quoted path with a space stays one path', () => {
    expect(all('cp "/Users/s/Documents/Mercury/opersource.fyi manger/README.md" "/bots/me/sandbox/README.md"')).toEqual([
      { path: '/Users/s/Documents/Mercury/opersource.fyi manger/README.md', mode: 'write' },
      { path: '/bots/me/sandbox/README.md', mode: 'write' },
    ]);
  });

  it('/dev/null is not a file, and reading commands read', () => {
    expect(all('curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/blog/index.html')).toEqual([]);
    expect(all('find "/Users/s/.mercury/bots/_shared" -name "*project*" 2>/dev/null')).toEqual([{ path: '/Users/s/.mercury/bots/_shared', mode: 'read' }]);
    expect(all('ls -la "/Users/s/Documents/Mercury/" | grep -i opersource')).toEqual([{ path: '/Users/s/Documents/Mercury/', mode: 'read' }]);
  });

  it('writes stay writes: redirects, -o, find -delete, sed -i, unknown commands', () => {
    expect(all('ls /a > /b/out.txt')).toEqual([{ path: '/a', mode: 'read' }, { path: '/b/out.txt', mode: 'write' }]);
    expect(all('curl -o /tmp/x.zip https://e.com/x.zip')).toEqual([{ path: '/tmp/x.zip', mode: 'write' }]);
    expect(all('find /a -name "*.log" -delete')).toEqual([{ path: '/a', mode: 'write' }]);
    expect(all("sed -i 's/a/b/' /etc/hosts")).toEqual([{ path: '/etc/hosts', mode: 'write' }]);
    expect(all('rm -rf /')).toEqual([{ path: '/', mode: 'write' }]);
    expect(all("grep -r '/api/v1' /src")).toEqual([{ path: '/src', mode: 'read' }]);
  });

  it('words and redirects as the shell splits them', () => {
    expect(shellWords('echo "a b" c\\ d 2>/dev/null')).toEqual(['echo', 'a b', 'c d', '2>', '/dev/null']);
  });

  it('read-only segments: quiet readers only, nothing written, nothing run', () => {
    expect(isReadOnlySegment('ls -lh "/x/_shared/"')).toBe(true);
    expect(isReadOnlySegment('find /x -name a -exec rm {} ;')).toBe(false);
    expect(isReadOnlySegment('cat /x > /y')).toBe(false);
    expect(isReadOnlySegment('cat $(echo /etc/passwd)')).toBe(false);
    expect(isReadOnlySegment('curl https://e.com')).toBe(false);
  });
});
