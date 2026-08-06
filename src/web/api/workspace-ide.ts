import { Hono } from 'hono';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, relative, extname, basename } from 'node:path';
import { getMercuryHome, loadConfig } from '../../utils/config.js';
import { generateText } from 'ai';
import type { ProviderRegistry } from '../../providers/registry.js';

let providerRegistry: ProviderRegistry | undefined;

export function setIDEProviders(pr: ProviderRegistry): void {
  providerRegistry = pr;
}

const CHAT_SETTINGS_FILE = join(getMercuryHome(), 'web-chat-settings.json');

function getWorkspaceRoot(): string {
  try {
    if (existsSync(CHAT_SETTINGS_FILE)) {
      const raw = JSON.parse(readFileSync(CHAT_SETTINGS_FILE, 'utf8'));
      if (raw.workspace) return raw.workspace;
    }
  } catch {}
  return process.cwd();
}

function git(args: string, cwd?: string): string {
  return execSync(`git ${args}`, {
    cwd: cwd || getWorkspaceRoot(),
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 5 * 1024 * 1024,
  }).trim();
}

function isInsideWorkspace(filePath: string): boolean {
  const root = getWorkspaceRoot();
  const resolved = resolve(root, filePath);
  return resolved.startsWith(root);
}

const ide = new Hono();

// ═════════════════════════════════════════════════════════════
//  Git Operations
// ═════════════════════════════════════════════════════════════

// Git status — files changed, staged, untracked
ide.get('/api/git/status', (c) => {
  try {
    const cwd = getWorkspaceRoot();
    const porcelain = git('status --porcelain -b', cwd);
    const lines = porcelain.split('\n').filter(Boolean);

    let branch = '';
    let upstream = '';
    let ahead = 0;
    let behind = 0;
    const files: Array<{ path: string; status: string; staged: boolean }> = [];

    for (const line of lines) {
      if (line.startsWith('## ')) {
        const branchLine = line.slice(3);
        const dotDot = branchLine.indexOf('...');
        if (dotDot >= 0) {
          branch = branchLine.slice(0, dotDot);
          const rest = branchLine.slice(dotDot + 3);
          const bracketIdx = rest.indexOf('[');
          upstream = bracketIdx >= 0 ? rest.slice(0, bracketIdx).trim() : rest.trim();
          const aheadMatch = rest.match(/ahead (\d+)/);
          const behindMatch = rest.match(/behind (\d+)/);
          if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
          if (behindMatch) behind = parseInt(behindMatch[1], 10);
        } else {
          branch = branchLine.split(' ')[0];
        }
        continue;
      }

      const xy = line.slice(0, 2);
      const filePath = line.slice(3);
      const indexStatus = xy[0];
      const workStatus = xy[1];

      if (indexStatus !== ' ' && indexStatus !== '?') {
        files.push({ path: filePath, status: mapStatus(indexStatus), staged: true });
      }
      if (workStatus !== ' ' && workStatus !== '?') {
        files.push({ path: filePath, status: mapStatus(workStatus), staged: false });
      }
      if (xy === '??') {
        files.push({ path: filePath, status: 'untracked', staged: false });
      }
    }

    return c.json({ branch, upstream, ahead, behind, files, cwd });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

function mapStatus(ch: string): string {
  const map: Record<string, string> = {
    'M': 'modified', 'A': 'added', 'D': 'deleted', 'R': 'renamed',
    'C': 'copied', 'U': 'unmerged', '?': 'untracked', '!': 'ignored',
  };
  return map[ch] || 'unknown';
}

// Git branches
ide.get('/api/git/branches', (c) => {
  try {
    const cwd = getWorkspaceRoot();
    const raw = git('branch -a --format="%(refname:short) %(HEAD) %(upstream:short)"', cwd);
    const branches = raw.split('\n').filter(Boolean).map(line => {
      const parts = line.split(' ');
      const name = parts[0];
      const isCurrent = parts[1] === '*';
      const upstream = parts[2] || '';
      return { name, isCurrent, upstream };
    });
    return c.json({ branches });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Switch branch
ide.post('/api/git/checkout', async (c) => {
  try {
    const body = await c.req.json<{ branch: string; create?: boolean }>();
    if (!body.branch) return c.json({ error: 'branch is required' }, 400);
    const cwd = getWorkspaceRoot();
    const flag = body.create ? '-b ' : '';
    const result = git(`checkout ${flag}${body.branch}`, cwd);
    return c.json({ success: true, message: result || `Switched to ${body.branch}` });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git diff — unstaged or staged changes
ide.get('/api/git/diff', (c) => {
  try {
    const cwd = getWorkspaceRoot();
    const staged = c.req.query('staged') === 'true';
    const filePath = c.req.query('file');
    let cmd = staged ? 'diff --cached' : 'diff';
    if (filePath) cmd += ` -- ${filePath}`;
    const diff = git(cmd, cwd);
    return c.json({ diff });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git log
ide.get('/api/git/log', (c) => {
  try {
    const cwd = getWorkspaceRoot();
    const count = Math.min(parseInt(c.req.query('count') || '20', 10), 100);
    const raw = git(`log --oneline --format="%H||%h||%an||%ae||%ar||%s" -${count}`, cwd);
    const commits = raw.split('\n').filter(Boolean).map(line => {
      const [hash, short, author, email, date, ...msgParts] = line.split('||');
      return { hash, short, author, email, date, message: msgParts.join('||') };
    });
    return c.json({ commits });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git stage (add)
ide.post('/api/git/stage', async (c) => {
  try {
    const body = await c.req.json<{ files: string[] }>();
    if (!body.files?.length) return c.json({ error: 'files array required' }, 400);
    const cwd = getWorkspaceRoot();
    for (const f of body.files) {
      if (!isInsideWorkspace(f)) return c.json({ error: `File outside workspace: ${f}` }, 403);
    }
    git(`add ${body.files.map(f => `"${f}"`).join(' ')}`, cwd);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git unstage
ide.post('/api/git/unstage', async (c) => {
  try {
    const body = await c.req.json<{ files: string[] }>();
    if (!body.files?.length) return c.json({ error: 'files array required' }, 400);
    const cwd = getWorkspaceRoot();
    git(`reset HEAD ${body.files.map(f => `"${f}"`).join(' ')}`, cwd);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git commit
ide.post('/api/git/commit', async (c) => {
  try {
    const body = await c.req.json<{ message: string }>();
    if (!body.message?.trim()) return c.json({ error: 'message is required' }, 400);
    const cwd = getWorkspaceRoot();
    const fullMessage = `${body.message.trim()}\n\nCo-authored-by: Mercury <mercury@cosmicstack.org>`;
    const result = git(`commit -m "${fullMessage.replace(/"/g, '\\"')}"`, cwd);
    return c.json({ success: true, message: result });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git push
ide.post('/api/git/push', async (c) => {
  try {
    const body = await c.req.json<{ remote?: string; branch?: string; setUpstream?: boolean }>();
    const cwd = getWorkspaceRoot();
    const remote = body.remote || 'origin';
    let cmd = `push ${remote}`;
    if (body.branch) cmd += ` ${body.branch}`;
    if (body.setUpstream) cmd += ' -u';
    const result = git(cmd, cwd);
    return c.json({ success: true, message: result || 'Pushed successfully' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Git pull
ide.post('/api/git/pull', async (c) => {
  try {
    const cwd = getWorkspaceRoot();
    const result = git('pull', cwd);
    return c.json({ success: true, message: result || 'Already up to date.' });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ═════════════════════════════════════════════════════════════
//  File Write / Save
// ═════════════════════════════════════════════════════════════

ide.put('/api/workspace/file', async (c) => {
  try {
    const body = await c.req.json<{ path: string; content: string }>();
    if (!body.path) return c.json({ error: 'path is required' }, 400);
    const root = getWorkspaceRoot();
    const fullPath = resolve(root, body.path);
    if (!fullPath.startsWith(root)) {
      return c.json({ error: 'Path outside workspace' }, 403);
    }
    writeFileSync(fullPath, body.content, 'utf8');
    return c.json({ success: true, path: body.path });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// ═════════════════════════════════════════════════════════════
//  Terminal — Execute a command (non-interactive, buffered)
// ═════════════════════════════════════════════════════════════

ide.post('/api/terminal/exec', async (c) => {
  const body = await c.req.json<{ command: string; cwd?: string }>();
  try {
    if (!body.command?.trim()) return c.json({ error: 'command is required' }, 400);

    const root = getWorkspaceRoot();
    const cwd = body.cwd ? resolve(root, body.cwd) : root;
    if (!cwd.startsWith(root)) {
      return c.json({ error: 'cwd outside workspace' }, 403);
    }

    const result = execSync(body.command, {
      cwd,
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      shell: '/bin/zsh',
      env: { ...process.env, TERM: 'xterm-256color' },
    });

    return c.json({ success: true, output: result, exitCode: 0, cwd });
  } catch (err: any) {
    return c.json({
      success: false,
      output: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status ?? 1,
      error: err.message,
      cwd: body.cwd || getWorkspaceRoot(),
    });
  }
});

// ═════════════════════════════════════════════════════════════
//  Project Info
// ═════════════════════════════════════════════════════════════

ide.get('/api/workspace/info', (c) => {
  const cwd = getWorkspaceRoot();
  let branch = '';
  let isGit = false;
  let remoteUrl = '';

  try {
    branch = git('rev-parse --abbrev-ref HEAD', cwd);
    isGit = true;
  } catch {}

  try {
    remoteUrl = git('remote get-url origin', cwd);
  } catch {}

  // Detect project type
  let projectType = 'unknown';
  if (existsSync(join(cwd, 'package.json'))) projectType = 'node';
  else if (existsSync(join(cwd, 'Cargo.toml'))) projectType = 'rust';
  else if (existsSync(join(cwd, 'go.mod'))) projectType = 'go';
  else if (existsSync(join(cwd, 'pyproject.toml')) || existsSync(join(cwd, 'setup.py'))) projectType = 'python';

  let projectName = basename(cwd);
  try {
    if (projectType === 'node') {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
      projectName = pkg.name || projectName;
    }
  } catch {}

  return c.json({
    cwd,
    projectName,
    projectType,
    isGit,
    branch,
    remoteUrl,
  });
});

// ═════════════════════════════════════════════════════════════
//  Generate Commit Message
// ═════════════════════════════════════════════════════════════

ide.post('/api/git/generate-commit-message', async (c) => {
  if (!providerRegistry) {
    return c.json({ error: 'AI provider not available' }, 503);
  }

  try {
    const cwd = getWorkspaceRoot();
    // Get staged diff
    let diff = '';
    try {
      diff = git('diff --cached --stat', cwd);
      if (!diff.trim()) {
        // Fallback to unstaged diff if nothing staged
        diff = git('diff --stat', cwd);
      }
    } catch {}

    if (!diff.trim()) {
      return c.json({ error: 'No changes to generate message for' }, 400);
    }

    // Also get the detailed diff (limited)
    let detailedDiff = '';
    try {
      detailedDiff = git('diff --cached', cwd);
      if (!detailedDiff.trim()) {
        detailedDiff = git('diff', cwd);
      }
    } catch {}

    // Truncate if too long
    if (detailedDiff.length > 8000) {
      detailedDiff = detailedDiff.slice(0, 8000) + '\n... (truncated)';
    }

    const provider = providerRegistry.getDefault();
    const result = await generateText({
      model: provider.getModelInstance(),
      system: `You are a git commit message generator. Given a diff, write a concise, conventional commit message.

Rules:
- Use conventional commit format: type(scope): description
- Types: feat, fix, refactor, docs, style, test, chore, perf, ci, build
- Keep the first line under 72 characters
- If the change is significant, add a blank line and 1-3 bullet points for the body
- Be specific about what changed, not generic
- Return ONLY the commit message text, nothing else`,
      messages: [
        { role: 'user', content: `Generate a commit message for these changes:\n\nStat:\n${diff}\n\nDiff:\n${detailedDiff}` },
      ],
      maxOutputTokens: 2000,
    });

    const message = (result.text ?? '').trim();
    if (!message) {
      // Surface a useful error instead of an empty string so the UI shows why
      const finishReason = (result as any).finishReason ?? 'unknown';
      console.warn('[generate-commit-message] empty response', {
        finishReason,
        usage: (result as any).usage,
      });
      return c.json(
        { error: `Model returned no text (finishReason: ${finishReason})` },
        502,
      );
    }
    return c.json({ message });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default ide;
