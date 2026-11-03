import { describe, expect, it } from 'vitest';
import { closePlan, coverageSection, fetchFailure, parsePlanLines, reportBody, reportFileName, ResearchRun, sourcesAppendix, stepFailure, unansweredFrom } from './research-run.js';
import { ResearchMode } from './research-mode.js';

const page = (title: string) => `# ${title}\n\n${'Real page text about the topic. '.repeat(20)}`;

describe('fetch failures', () => {
  it('names why a page could not be read', () => {
    expect(fetchFailure('HTTP 403 Forbidden for https://x.com/a')).toBe('blocked or behind a login (HTTP 403)');
    expect(fetchFailure('HTTP 404 Not Found for https://x.com/a')).toBe('page not found (HTTP 404)');
    expect(fetchFailure('HTTP 429 Too Many Requests for https://x.com')).toBe('rate-limited (HTTP 429)');
    expect(fetchFailure('HTTP 503 Service Unavailable for https://x.com')).toBe('the site had an error (HTTP 503)');
    expect(fetchFailure('Request to https://x.com timed out after 30 seconds.')).toBe('timed out after 30 s');
    expect(fetchFailure('Error fetching https://x.com: getaddrinfo ENOTFOUND x.com')).toBe('getaddrinfo ENOTFOUND x.com');
    expect(fetchFailure('Enable JavaScript')).toMatch(/almost no readable text/);
    expect(fetchFailure(page('A real article'))).toBeNull();
  });

  it('marks failed steps that used to show a green check', () => {
    expect(stepFailure('fetch_url', 'HTTP 403 Forbidden for https://x.com')).toMatch(/HTTP 403/);
    expect(stepFailure('fetch_url', 'Request to https://x.com timed out after 30 seconds.')).toMatch(/timed out/);
    expect(stepFailure('web_search', 'Error: web search found nothing')).toBeTruthy();
    expect(stepFailure('fetch_url', page('fine'))).toBeNull();
    // A short but real tool result elsewhere is not a failure.
    expect(stepFailure('read_file', 'ok')).toBeNull();
  });
});

describe('a research run', () => {
  it('counts searches, reads and failures, and keeps a page read once as read', () => {
    const run = new ResearchRun('solar storms', 's1', 225);
    run.observe('web_search', { query: 'solar storm 2026' }, 'Results:\n1. https://a.org/x\n2. https://b.org/y');
    run.observe('web_search', { query: 'nothing' }, 'Error: web search found nothing: no source found anything (Parallel: timed out). Tell the owner which sources were tried');
    run.observe('fetch_url', { url: 'https://a.org/x' }, page('Solar storms explained'));
    run.observe('fetch_url', { url: 'https://paywall.com/p' }, 'HTTP 403 Forbidden for https://paywall.com/p');
    run.observe('fetch_url', { url: 'https://a.org/x' }, 'Request to https://a.org/x timed out after 30 seconds.');
    const s = run.snapshot();
    expect(s).toMatchObject({ searches: 2, failedSearches: 1, read: 1, failed: 1, steps: 5, phase: 'reading', state: 'running' });
    expect(s.searchList[0].results).toBe(2);
    expect(s.searchList[1].reason).toMatch(/Parallel: timed out/);
    expect(s.sourceList.find((x) => x.url === 'https://a.org/x')).toMatchObject({ status: 'read', title: 'Solar storms explained', domain: 'a.org' });
    expect(run.notesText()).toContain('### Source: https://a.org/x');
  });

  it('a retry that works replaces the failure', () => {
    const run = new ResearchRun('t', 's1', 10);
    run.observe('fetch_url', { url: 'https://x.org' }, 'HTTP 503 Service Unavailable for https://x.org');
    run.observe('fetch_url', { url: 'https://x.org' }, page('Back up'));
    expect(run.snapshot()).toMatchObject({ read: 1, failed: 0 });
  });

  it('marks cited sources and lists all of them with the report', () => {
    const run = new ResearchRun('t', 's1', 10);
    run.observe('fetch_url', { url: 'https://a.org/x' }, page('A'));
    run.observe('fetch_url', { url: 'https://b.org/y' }, page('B'));
    run.markCited('As [A says](https://a.org/x), …');
    expect(run.snapshot().cited).toBe(1);
    const appendix = sourcesAppendix(run);
    expect(appendix).toContain('✓ cited · [A](https://a.org/x)');
    expect(appendix).toContain('· read · [B](https://b.org/y)');
  });

  it('ends once', () => {
    const run = new ResearchRun('t', 's1', 10);
    run.end('stopped', 'you stopped it');
    run.end('done');
    expect(run.snapshot()).toMatchObject({ state: 'stopped', cut: 'you stopped it' });
  });
});

describe('coverage & gaps', () => {
  it('is empty for a clean finished run', () => {
    const run = new ResearchRun('t', 's1', 10);
    run.observe('fetch_url', { url: 'https://a.org' }, page('A'));
    expect(coverageSection(run)).toBe('');
  });

  it('says why a cut run is incomplete, what is not covered, and what failed', () => {
    const run = new ResearchRun('t', 's1', 10);
    run.observe('fetch_url', { url: 'https://a.org' }, page('A'));
    run.observe('fetch_url', { url: 'https://b.org/p' }, 'HTTP 403 Forbidden for https://b.org/p');
    run.observe('web_search', { query: 'q' }, 'Error: web search found nothing: blocked (429)');
    const text = coverageSection(run, { cut: 'you asked it to finish now', unanswered: unansweredFrom([{ label: 'Costs', status: 'pending' }, { label: 'History', status: 'done' }, { label: 'Synthesize findings into a report', status: 'pending' }]) });
    expect(text).toContain('## Coverage & gaps');
    expect(text).toContain('stopped early because you asked it to finish now');
    expect(text).toContain('from the 1 source read');
    expect(text).toContain('- Costs');
    expect(text).not.toContain('- History');
    expect(text).not.toContain('Synthesize');
    expect(text).toContain('[b.org](https://b.org/p): blocked or behind a login (HTTP 403)');
    expect(text).toContain('“q”');
  });
});

describe('helpers', () => {
  it('reads plan lines and names report files', () => {
    expect(parsePlanLines('# Sub-questions for Solar Storms\n\nWhat causes solar storms?')).toEqual(['What causes solar storms?']);
    expect(parsePlanLines('Sub-questions:\n1. What causes solar storms?\n- How are they forecast?\n• What did the May 2024 storm do?\nok')).toEqual([
      'What causes solar storms?', 'How are they forecast?', 'What did the May 2024 storm do?',
    ]);
    expect(reportFileName('Solar Storms: A Guide!', new Date(2026, 10, 2, 9, 5).getTime())).toBe('2026-11-02-0905-solar-storms-a-guide.md');
  });
});

describe('research mode is one run', () => {
  it('applies to the chat that asked, then switches off', () => {
    const mode = new ResearchMode();
    mode.setOn('topic', { sessionId: 'a' });
    expect(mode.armedForSession('b')).toBe(false);
    expect(mode.armedForSession('a')).toBe(true);
    expect(mode.getMaxStepsMultiplier()).toBe(1);
    const run = mode.beginRun('a', 'what about it', 225);
    expect(run.topic).toBe('topic');
    expect(mode.getMaxStepsMultiplier()).toBe(3);
    expect(mode.getSystemPromptSuffix()).toContain('RESEARCH MODE IS ACTIVE');
    expect(mode.armedForSession('a')).toBe(false);
    mode.endRun();
    expect(mode.isActive()).toBe(false);
    expect(mode.getSystemPromptSuffix()).toBe('');
    expect(mode.stateFor('a').run?.state).toBe('done');
    expect(mode.stateFor('b').run).toBeNull();
  });

  it('puts an approved plan in the prompt', () => {
    const mode = new ResearchMode();
    mode.setOn(undefined, { planFirst: true });
    const run = mode.beginRun('a', 'solar storms', 225);
    expect(run.planFirst).toBe(true);
    run.setQuestions(['What causes them?', 'How are they forecast?']);
    expect(mode.getSystemPromptSuffix()).toContain('1. What causes them?');
  });
});

describe('the report kept', () => {
  it('drops the narration before the article', () => {
    expect(reportBody("I'll research this.\n\nNow let me search:\n\n# Solar storms\n\nBody")).toBe('# Solar storms\n\nBody');
    expect(reportBody('No heading, just text')).toBe('No heading, just text');
  });

  it('uses the article the model saved to a file when the reply is only a summary', () => {
    const run = new ResearchRun('t', 's1', 10);
    const article = `# Solid-state batteries\n\n${'A long article paragraph. '.repeat(100)}`;
    run.observe('create_file', { path: '/Users/me/ssb.md', content: article }, 'Successfully created /Users/me/ssb.md (19811 bytes)');
    run.observe('write_file', { path: '/Users/me/notes.txt', content: 'x'.repeat(5000) }, 'ok');
    expect(run.writtenArticle?.path).toBe('/Users/me/ssb.md');
    expect(reportBody('Done. Here is a summary: key takeaways…', run.writtenArticle)).toBe(article.trim());
    // A real article in the reply wins over a short file.
    expect(reportBody(article, { content: '# Short\n\nnotes' })).toBe(article.trim());
  });
});

describe('the checklist when a run ends', () => {
  const plan = [
    { label: 'Who builds them', status: 'done' as const },
    { label: 'What they cost', status: 'active' as const },
    { label: 'Synthesize findings into a report', status: 'pending' as const },
  ];

  it('a finished run ticks every step (models skip the last one)', () => {
    expect(closePlan(plan, 'done')?.map((s) => s.status)).toEqual(['done', 'done', 'done']);
  });

  it('a report written after a cut ticks the writing, keeps the unreached questions open', () => {
    expect(closePlan(plan, 'partial')?.map((s) => s.status)).toEqual(['done', 'pending', 'done']);
  });

  it('a stopped or failed run leaves it, and an already-closed plan is no change', () => {
    expect(closePlan(plan, 'stopped')).toBeNull();
    expect(closePlan(plan, 'failed')).toBeNull();
    expect(closePlan(plan.map((s) => ({ ...s, status: 'done' as const })), 'done')).toBeNull();
    expect(closePlan([], 'done')).toBeNull();
  });

  it('only a run that made the plan closes it', () => {
    const run = new ResearchRun('t', 's1', 10);
    expect(run.planned).toBe(false);
    run.observe('update_plan', { steps: [] }, 'Plan updated');
    expect(run.planned).toBe(true);
    expect(run.snapshot().steps).toBe(1);
  });
});
