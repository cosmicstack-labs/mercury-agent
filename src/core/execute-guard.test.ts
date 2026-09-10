import { describe, expect, it } from 'vitest';
import {
  MAX_EXECUTE_CONTINUATIONS,
  MAX_VERIFICATION_CONTINUATIONS,
  executeContinuationPrompt,
  isFailedToolResult,
  isTextDeliverableRequest,
  responseAsksUser,
  shouldForceExecuteContinuation,
  shouldRequireVerification,
  verificationPrompt,
  wakeUpPrompt,
} from './execute-guard.js';

const ok = (names: string[]): Map<string, boolean> => new Map(names.map((n) => [n, true]));

describe('chat delivery contract', () => {
  it('text deliverables are exempt — the reply itself is the work', () => {
    for (const text of [
      'write a poem about the sea',
      'draft an email to the landlord',
      'give me a catchy slogan for the app',
      'write a short story about a fox',
      'write the lyrics for a chorus',
      'write a haiku about autumn',
      'brainstorm names for the project',
      'write a blog post intro',
    ]) {
      expect(isTextDeliverableRequest(text), text).toBe(true);
    }
  });

  it('repo/code-shaped requests are NOT text deliverables — the guard applies in chat', () => {
    for (const text of [
      'fix the login bug',
      'build a dashboard for the API',
      'add tests to the auth module',
      'refactor the session store',
      'create a component for the settings page',
      'implement the endpoint',
      'set up the database schema',
    ]) {
      expect(isTextDeliverableRequest(text), text).toBe(false);
    }
  });

  it('the narration guard still fires for chat implementation requests with no tools', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'fix the login bug',
      hasApprovedPlan: false,
      toolsUsed: [],
      toolsSucceeded: new Map(),
    })).toBe(true);
  });
});

describe('execute-mode completion guard', () => {
  it('forces continuation when an implementation request ended with no tools', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'please develop it now',
      hasApprovedPlan: false,
      toolsUsed: [],
      toolsSucceeded: new Map(),
    })).toBe(true);
    expect(shouldForceExecuteContinuation({
      taskText: 'build the Omega Project per its spec',
      hasApprovedPlan: false,
      toolsUsed: ['read_file', 'list_dir', 'git_status'],
      toolsSucceeded: ok(['read_file', 'list_dir', 'git_status']),
    })).toBe(true);
    expect(shouldForceExecuteContinuation({
      taskText: 'create a landing page for my app',
      hasApprovedPlan: false,
      toolsUsed: [],
      toolsSucceeded: new Map(),
    })).toBe(true);
  });

  it('allows finishing once a mutating tool actually ran (legacy semantics when success map is absent)', () => {
    for (const tool of ['write_file', 'edit_file', 'create_file', 'run_command', 'git_commit', 'delegate_task']) {
      expect(shouldForceExecuteContinuation({
        taskText: 'build the Omega Project per its spec',
        hasApprovedPlan: false,
        toolsUsed: ['read_file', tool, 'list_dir'],
      })).toBe(false);
    }
  });

  it('allows finishing when a mutating tool produced a successful result', () => {
    for (const tool of ['write_file', 'edit_file', 'create_file', 'run_command', 'git_commit']) {
      expect(shouldForceExecuteContinuation({
        taskText: 'build the Omega Project per its spec',
        hasApprovedPlan: false,
        toolsUsed: ['read_file', tool, 'list_dir'],
        toolsSucceeded: ok(['read_file', tool, 'list_dir']),
      })).toBe(false);
    }
  });

  it('does NOT accept a mutating tool that only ever failed', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'build the Omega Project per its spec',
      hasApprovedPlan: false,
      toolsUsed: ['create_file', 'write_file'],
      toolsSucceeded: new Map([['create_file', false], ['write_file', false]]),
    })).toBe(true);
    // Mixed: one succeeded → satisfied.
    expect(shouldForceExecuteContinuation({
      taskText: 'build the Omega Project per its spec',
      hasApprovedPlan: false,
      toolsUsed: ['create_file', 'write_file'],
      toolsSucceeded: new Map([['create_file', false], ['write_file', true]]),
    })).toBe(false);
  });

  it('allows finishing when the model paused with ask_user', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'build the Omega Project',
      hasApprovedPlan: false,
      toolsUsed: ['read_file', 'ask_user'],
      toolsSucceeded: ok(['read_file']),
    })).toBe(false);
  });

  it('forces continuation whenever an approved plan is pending', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'go ahead',
      hasApprovedPlan: true,
      toolsUsed: ['git_log'],
      toolsSucceeded: ok(['git_log']),
    })).toBe(true);
    expect(shouldForceExecuteContinuation({
      taskText: 'go ahead',
      hasApprovedPlan: true,
      toolsUsed: [],
      toolsSucceeded: new Map(),
    })).toBe(true);
  });

  it('never fires on conversation-only requests', () => {
    const noTools: string[] = [];
    for (const text of [
      'thanks',
      'Thank you!',
      'ok',
      'what is 2+2?',
      'why does this fail?',
      'how do I install mercury?',
      'explain this file',
      'tell me about the codebase',
      'hi',
    ]) {
      expect(shouldForceExecuteContinuation({
        taskText: text,
        hasApprovedPlan: false,
        toolsUsed: noTools,
        toolsSucceeded: new Map(),
      })).toBe(false);
    }
  });

  it('never fires for read-only research phrasing', () => {
    expect(shouldForceExecuteContinuation({
      taskText: 'list the files in src',
      hasApprovedPlan: false,
      toolsUsed: ['list_dir'],
      toolsSucceeded: ok(['list_dir']),
    })).toBe(false);
  });

  it('allows an empty task text to finish', () => {
    expect(shouldForceExecuteContinuation({
      taskText: '',
      hasApprovedPlan: false,
      toolsUsed: [],
      toolsSucceeded: new Map(),
    })).toBe(false);
  });

  it('bounds the continuation rounds', () => {
    // Generous by design — automatic continuation is the norm; the pause is
    // a runaway backstop, not a checkpoint.
    expect(MAX_EXECUTE_CONTINUATIONS).toBeGreaterThanOrEqual(3);
    expect(MAX_EXECUTE_CONTINUATIONS).toBeLessThanOrEqual(8);
  });

  it('builds a bounded continuation nudge', () => {
    const prompt = executeContinuationPrompt('build the omega project');
    expect(prompt).toContain('EXECUTE-MODE GUARD');
    expect(prompt).toContain('build the omega project');
    expect(prompt).toContain('tools');
    const long = 'x'.repeat(500);
    const bounded = executeContinuationPrompt(long);
    expect(bounded).not.toContain('x'.repeat(250));
  });

  it('detects failed tool results from executor output markers', () => {
    expect(isFailedToolResult('Error: Permission denied for write access to /repo')).toBe(true);
    expect(isFailedToolResult('Command exited with code 1')).toBe(true);
    expect(isFailedToolResult('⏱ Command timed out after 120s.')).toBe(true);
    expect(isFailedToolResult('Command failed: something broke')).toBe(true);
    expect(isFailedToolResult('Successfully created /repo/src/app.ts (120 bytes)')).toBe(false);
    expect(isFailedToolResult('Successfully wrote 512 bytes to /repo/src/app.ts')).toBe(false);
    expect(isFailedToolResult('src/app.ts +8 -2')).toBe(false);
    // Error markers beyond the first 300 chars don't flag an otherwise
    // successful result (error summary belongs at the head).
    const long = 'ok '.repeat(200) + 'Error: at the very end';
    expect(isFailedToolResult(long)).toBe(false);
  });
});
describe('evidence-based verification gate', () => {
  it('requires verification when changes landed but nothing verified them', () => {
    expect(shouldRequireVerification({
      taskText: 'add the export endpoint',
      hasApprovedPlan: false,
      commandsRun: ['ls src'],
      toolsSucceeded: ok(['edit_file', 'write_file']),
    })).toBe(true);
  });

  it('accepts a build/test/typecheck run as evidence', () => {
    for (const command of [
      'npm test',
      'npm run build',
      'pnpm typecheck',
      'npx vitest run src/app.test.ts',
      'cargo test',
      'go test ./...',
      'make check',
      'pytest -q',
      'tsc --noEmit',
    ]) {
      expect(shouldRequireVerification({
        taskText: 'add the export endpoint',
        hasApprovedPlan: false,
        commandsRun: [command],
        toolsSucceeded: ok(['edit_file']),
      }), command).toBe(false);
    }
  });

  it('never requires verification without a successful mutation', () => {
    expect(shouldRequireVerification({
      taskText: 'add the export endpoint',
      hasApprovedPlan: false,
      commandsRun: [],
      toolsSucceeded: ok(['read_file']),
    })).toBe(false);
    expect(shouldRequireVerification({
      taskText: 'add the export endpoint',
      hasApprovedPlan: false,
      commandsRun: [],
      toolsSucceeded: new Map([['edit_file', false]]),
    })).toBe(false);
  });

  it('skips conversational and question-style tasks', () => {
    expect(shouldRequireVerification({
      taskText: 'thanks!',
      hasApprovedPlan: false,
      commandsRun: [],
      toolsSucceeded: ok(['edit_file']),
    })).toBe(false);
    expect(shouldRequireVerification({
      taskText: 'why is the build failing?',
      hasApprovedPlan: false,
      commandsRun: [],
      toolsSucceeded: ok(['edit_file']),
    })).toBe(false);
  });

  it('treats non-verification commands as insufficient even for approved plans', () => {
    expect(shouldRequireVerification({
      taskText: 'implement the plan',
      hasApprovedPlan: true,
      commandsRun: ['git status', 'ls'],
      toolsSucceeded: ok(['create_file']),
    })).toBe(true);
  });

  it('bounds verification rounds to one', () => {
    expect(MAX_VERIFICATION_CONTINUATIONS).toBe(1);
  });

  it('builds a verification nudge', () => {
    const prompt = verificationPrompt('add the export endpoint');
    expect(prompt).toContain('EXECUTE-MODE VERIFICATION');
    expect(prompt).toContain('add the export endpoint');
    expect(prompt).toContain('build, test, or typecheck');
  });
});

describe('responseAsksUser — prose questions are legitimate pauses', () => {
  it('detects a turn that ends by asking the user something', () => {
    expect(responseAsksUser('Could you remind me what the AI bot was supposed to do?')).toBe(true);
    expect(responseAsksUser('Which option do you want?\n2. A Telegram bot that creates notes?')).toBe(true);
    expect(responseAsksUser('Working on it.\n\nShall I proceed?')).toBe(true);
  });

  it('does not treat statements or mid-text questions as user questions', () => {
    expect(responseAsksUser('Built the endpoint. What changed: the router now handles POST /notes.')).toBe(false);
    expect(responseAsksUser('Why did this fail? The answer: missing env var. Fixed now.')).toBe(false);
    expect(responseAsksUser('')).toBe(false);
  });
});

describe('wakeUpPrompt — the final automatic attempt', () => {
  it('demands a mutating tool call first, zero prose', () => {
    const prompt = wakeUpPrompt('build the 3D world');
    expect(prompt).toContain('WAKE-UP CALL');
    expect(prompt).toContain('MUST begin with a mutating tool call');
    expect(prompt).toContain('create_file');
    expect(prompt).toContain('ZERO prose');
    expect(prompt).toContain('3D world');
  });
});
