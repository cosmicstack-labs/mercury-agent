import { describe, expect, it } from 'vitest';
import { ResearchMode } from './research-mode.js';

describe('research session forks', () => {
  it('transfers a scoped arm only to its session and only once', () => {
    const root = new ResearchMode();
    root.setOn('Solar storms', { sessionId: 'a', planFirst: true });
    const other = root.forkForSession('b');
    expect(other.isActive()).toBe(false);
    expect(other.getTopic()).toBeNull();
    expect(other.isPlanFirst()).toBe(false);
    expect(root.armedForSession('a')).toBe(true);

    const mine = root.forkForSession('a');
    expect(mine.armedForSession('a')).toBe(true);
    expect(mine.armedForSession('b')).toBe(false);
    expect(mine.getTopic()).toBe('Solar storms');
    expect(mine.isPlanFirst()).toBe(true);
    expect(root.isActive()).toBe(false);
    expect(root.forkForSession('a').isActive()).toBe(false);
  });

  it('lets exactly one session claim an unscoped next-run arm', () => {
    const root = new ResearchMode();
    root.setOn('Shared next topic');
    const first = root.forkForSession('a');
    const second = root.forkForSession('b');
    expect(first.armedForSession('a')).toBe(true);
    expect(first.armedForSession('b')).toBe(false);
    expect(second.isActive()).toBe(false);
    expect(root.isActive()).toBe(false);
  });

  it('keeps simultaneous runs independent while root screens observe both live outcomes', () => {
    const root = new ResearchMode();
    root.setOn('Solar storms', { sessionId: 'a', planFirst: true });
    const a = root.forkForSession('a');
    const aRun = a.beginRun('a', 'ignored in favor of topic', 225);
    root.setOn('Batteries', { sessionId: 'b' });
    const b = root.forkForSession('b');
    const bRun = b.beginRun('b', 'also ignored', 75);
    aRun.setQuestions(['How are storms forecast?']);
    bRun.observe('web_search', { query: 'battery chemistry' }, 'https://example.com/batteries');

    expect(root.currentRun()).toBeNull();
    expect(a.currentRun()).toBe(aRun);
    expect(b.currentRun()).toBe(bRun);
    expect(root.runFor('a')).toBe(aRun);
    expect(root.runFor('b')).toBe(bRun);
    expect(root.stateFor('a').run).toMatchObject({ state: 'running', topic: 'Solar storms', questions: ['How are storms forecast?'] });
    expect(root.stateFor('b').run).toMatchObject({ state: 'running', topic: 'Batteries', searches: 1 });
    expect(a.getSystemPromptSuffix()).not.toContain('Batteries');
    expect(b.getSystemPromptSuffix()).not.toContain('Solar storms');

    a.endRun();
    expect(root.stateFor('a').run?.state).toBe('done');
    expect(root.stateFor('b').run?.state).toBe('running');
    expect(b.currentRun()).toBe(bRun);
    bRun.end('stopped', 'Owner stopped chat b');
    b.endRun();
    expect(root.stateFor('b').run?.state).toBe('stopped');
  });

  it('does not copy or end a serial root run when another session is forked', () => {
    const root = new ResearchMode();
    root.setOn('Root research', { sessionId: 'root' });
    const running = root.beginRun('root', 'Research', 75);
    root.setOn('Next research', { sessionId: 'other' });
    const other = root.forkForSession('other');
    expect(other.currentRun()).toBeNull();
    expect(root.currentRun()).toBe(running);
    other.beginRun('other', 'Research', 75);
    other.endRun();
    expect(running.outcome).toBe('running');
    expect(root.currentRun()).toBe(running);
    root.endRun();
    expect(running.outcome).toBe('done');
  });
});
