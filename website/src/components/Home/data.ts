/**
 * Homepage content. Everything a visitor (or a crawler) reads on the landing
 * page lives here so copy edits never touch layout code.
 *
 * Every claim must be verifiable against the repo or public docs — the page
 * sells trust, so an unprovable line costs more than a missing one.
 */

export const SITE_URL = 'https://mercuryagent.sh';
export const GITHUB_URL = 'https://github.com/cosmicstack-labs/mercury-agent';
export const NPM_URL = 'https://www.npmjs.com/package/@cosmicstack/mercury-agent';
export const SKILLS_URL = 'https://skills.mercuryagent.sh';

/** Bump on release, together with the announcement bar in docusaurus.config.ts. */
export const RELEASE = { version: '1.3.0', name: 'Mercury Bots', notes: '/docs/releases/1.3.0' };

export const SEO = {
  title: 'Mercury Agent: the open-source AI agent you can leave running',
  description:
    'Mercury is an open-source, self-hosted AI agent that runs 24/7 on your machine. It remembers what matters, asks before it acts, and works with any model from your terminal, browser, Telegram, Discord, Slack, or Signal.',
};

export type TermLine = {
  /** cmd: shell prompt · in: user message · ok: tool success · dim: meta
   *  ask: approval prompt · opt / sel: approval options · done: completion
   *  mem: memory write · say: Mercury's reply · warn: paused / needs-you */
  k: 'cmd' | 'in' | 'ok' | 'dim' | 'ask' | 'opt' | 'sel' | 'done' | 'mem' | 'say' | 'warn' | 'gap';
  t: string;
  /** right-aligned annotation */
  n?: string;
};

export const HERO_SCRIPT: TermLine[] = [
  { k: 'cmd', t: 'mercury' },
  { k: 'dim', t: '☿ Mercury 1.3.0 · deepseek-chat · Ask Me mode' },
  { k: 'gap', t: '' },
  { k: 'in', t: 'tidy CHANGELOG for 1.3.1, push it, and open a PR' },
  { k: 'ok', t: 'git_status', n: 'read · no prompt' },
  { k: 'ok', t: 'read_file CHANGELOG.md', n: 'read · no prompt' },
  { k: 'ok', t: 'edit_file CHANGELOG.md', n: '+14 −2' },
  { k: 'ok', t: 'git_commit "docs: changelog for 1.3.1"' },
  { k: 'ask', t: 'git_push origin docs/changelog-1.3.1 — modifies a remote' },
  { k: 'sel', t: 'Yes — approve once' },
  { k: 'opt', t: 'Always — remember this permission' },
  { k: 'opt', t: 'No — deny' },
  { k: 'ok', t: 'git_push', n: 'approved once' },
  { k: 'ok', t: 'create_pr #214 "docs: changelog for 1.3.1"' },
  { k: 'done', t: 'Task complete · 6 steps · 38s' },
  { k: 'mem', t: 'Remembered · changelog PRs go on a docs/* branch' },
];

export const ASK_SCRIPT: TermLine[] = [
  { k: 'in', t: 'clear out the build cache and old logs' },
  { k: 'ok', t: 'list_dir ./build', n: 'read · no prompt' },
  { k: 'ask', t: 'run_command rm -rf build/.cache logs/*.old' },
  { k: 'sel', t: 'Yes — approve once' },
  { k: 'opt', t: 'Always — remember this permission' },
  { k: 'opt', t: 'No — deny' },
  { k: 'ok', t: 'run_command', n: 'approved once' },
  { k: 'gap', t: '' },
  { k: 'in', t: 'now wipe everything under /' },
  { k: 'warn', t: 'Blocked · `rm -rf /` is on the shell blocklist. It never runs, in any mode.' },
];

export const MEMORY_SCRIPT: TermLine[] = [
  { k: 'in', t: 'draft the weekly update for the team' },
  { k: 'ok', t: 'search_memory "weekly update"', n: '3 hits' },
  { k: 'dim', t: '  · prefers bullet points, no emoji' },
  { k: 'dim', t: '  · Friday updates go to #eng-leads' },
  { k: 'dim', t: '  · Priya owns the billing migration' },
  { k: 'say', t: 'Drafted in your usual format: bullets, billing migration first (Priya), ready for #eng-leads.' },
  { k: 'mem', t: 'Updated · billing migration moved to "in review"' },
];

export const ALWAYS_ON_SCRIPT: TermLine[] = [
  { k: 'cmd', t: 'mercury up' },
  { k: 'ok', t: 'service installed · starts on boot' },
  { k: 'ok', t: 'daemon running', n: 'pid 48211' },
  { k: 'gap', t: '' },
  { k: 'dim', t: '07:00  ◷  daily-brief       → Telegram' },
  { k: 'dim', t: '09:00  ✒  release-notes bot → drafted 620 words' },
  { k: 'dim', t: '09:02  ⚑  fact-checker      → 14/14 sourced' },
  { k: 'warn', t: '11:40  needs you · deploy bot wants shell access it was never granted' },
  { k: 'done', t: 'Fleet idle · journals clean · 0 in dead-letter queue' },
];

export const HONEST_SCRIPT: TermLine[] = [
  { k: 'in', t: 'migrate the settings page to the new form library' },
  { k: 'ok', t: 'edit_file src/settings/Form.tsx', n: '+86 −41' },
  { k: 'ok', t: 'run_command npm run typecheck', n: '0 errors' },
  { k: 'ok', t: 'run_command npm test settings', n: '12 passed' },
  { k: 'done', t: 'Task complete · 9 steps · 2m 14s', n: 'verified' },
  { k: 'gap', t: '' },
  { k: 'in', t: 'and the billing page' },
  { k: 'ok', t: 'edit_file src/billing/Form.tsx', n: '+52 −30' },
  { k: 'warn', t: 'Paused · npm test billing fails (2). Not calling this done. Say "continue" to resume.' },
];

export type Chapter = {
  id: string;
  kicker: string;
  title: string;
  body: string;
  points: string[];
  link: { to: string; label: string };
  script: TermLine[];
  scriptTitle: string;
};

export const CHAPTERS: Chapter[] = [
  {
    id: 'asks-first',
    kicker: '01 · Control',
    title: 'It asks before it acts.',
    body:
      'Reads are free. Anything that writes, runs, pushes, or reaches outside its scope waits for your answer. Approve once, approve for good, or say no. Some commands never run, no matter what mode you pick.',
    points: [
      'Ask Me or Allow All, chosen per session',
      'Shell blocklist: sudo, rm -rf /, and its flag-swapped variants',
      'Folder-level read/write scopes per channel and per sender role',
      'Bots fail closed: a missing permission is a denial, not a pop-up',
    ],
    link: { to: '/docs/reference/permissions', label: 'How permissions work' },
    script: ASK_SCRIPT,
    scriptTitle: 'mercury · ask me',
  },
  {
    id: 'remembers',
    kicker: '02 · Memory',
    title: 'It remembers what matters.',
    body:
      'A Second Brain on your own disk. Mercury pulls out preferences, people, and decisions as you work, resolves contradictions, and consolidates every hour, so tomorrow does not start from zero.',
    points: [
      'SQLite + FTS5 full-text search, stored in ~/.mercury',
      '10 memory types, auto-extraction, conflict resolution',
      '/memory to search, pause, or clear it at any time',
      'Personality lives in markdown files you own: soul.md, persona.md',
    ],
    link: { to: '/docs/reference/second-brain', label: 'Inside the Second Brain' },
    script: MEMORY_SCRIPT,
    scriptTitle: 'mercury · second brain',
  },
  {
    id: 'always-on',
    kicker: '03 · Autonomy',
    title: 'It keeps working when you don’t.',
    body:
      'One command makes Mercury a background service that starts on boot and restarts itself on a crash. Schedule routines, run a fleet of persistent bots, and hear back on whichever channel you are on.',
    points: [
      'mercury up: system service, crash recovery, boot start',
      'Cron schedules, heartbeat checks, proactive notifications',
      'Mercury Bots: persistent specialists with their own model and memory',
      'Durable job queue: work survives restarts and failures can be replayed',
    ],
    link: { to: '/docs/integrations/mercury-bots', label: 'Meet Mercury Bots' },
    script: ALWAYS_ON_SCRIPT,
    scriptTitle: 'mercury · daemon',
  },
  {
    id: 'honest',
    kicker: '04 · Honesty',
    title: 'It tells you the truth about “done”.',
    body:
      'Agents love to say “task complete”. Mercury works under a completion contract: a task ends either verified, with a build, typecheck, or test that actually ran, or paused with the blocker named. Mercury never claims success it can’t show.',
    points: [
      'Evidence-gated completion banners in Mercury Code',
      'Honest pauses that name the blocker, never a silent stop',
      'Daily token budgets with live usage and Token Saver Mode',
      'Provider fallback mid-task, so one outage does not end the run',
    ],
    link: { to: '/docs/reference/completion-architecture', label: 'The completion contract' },
    script: HONEST_SCRIPT,
    scriptTitle: 'mercury code · auto',
  },
];

export const PRODUCTS = [
  {
    name: 'Mercury Code',
    tag: 'mercury code',
    title: 'A senior engineer inside your repo.',
    body:
      'A full-screen, repo-aware coding environment. It plans and builds in one AUTO flow with a live checklist, hands background work to sub-agents, and shows per-file diffs at the end.',
    to: '/docs/integrations/coding-workspace',
  },
  {
    name: 'Mercury Bots',
    tag: '/bots',
    title: 'A small team, not a single chat.',
    body:
      'Persistent bots, each with its own persona, model, memory, and permissions. Promote one to fleet lead and it recruits a crew. Export the whole fleet as a single bundle.',
    to: '/docs/integrations/mercury-bots',
  },
  {
    name: 'Mercury Cloud',
    tag: 'mercury cloud connect',
    title: 'Reachable from anywhere. Optional.',
    body:
      'Pair your agent from the terminal and keep it online over a persistent connection. No port forwarding, reverse proxy, or certificates. Everything still works without it.',
    to: '/cloud',
  },
];

export const CHANNELS = [
  { name: 'Terminal', note: 'Ink TUI, slash commands, workspace IDE' },
  { name: 'Web', note: 'Local dashboard, Kanban, bot cockpit' },
  { name: 'Telegram', note: 'Pinned status card, admin/member roles' },
  { name: 'Discord', note: 'Slash commands, streaming edits' },
  { name: 'Slack', note: 'Socket Mode, no public endpoint' },
  { name: 'Signal', note: 'End-to-end encrypted via signal-cli' },
];

export const PROVIDERS = [
  'Anthropic', 'OpenAI', 'DeepSeek', 'Grok', 'ChatGPT Plus / Pro', 'GitHub Copilot',
  'Ollama Local', 'Ollama Cloud', 'Atomic Chat', 'Mercury Cloud',
];

export type CompareRow = [string, string, string, string, string];

/** Checked September 2026 against each product's official docs and public repos. */
export const COMPARE: { head: string[]; rows: CompareRow[] } = {
  head: ['', 'Mercury', 'Claude Code', 'Codex CLI', 'Gemini CLI'],
  rows: [
    ['Model providers', 'Any provider, API key or OAuth, auto-fallback', 'Anthropic + third-party', 'OpenAI only', 'Gemini only'],
    ['Scheduled autonomy', 'Daemon + cron + bot routines, 24/7 local', 'Cloud routines + desktop tasks', '—', '—'],
    ['Persistent agents', 'Bots with persona, memory, permissions', 'Sub-agents + background agents', '—', '—'],
    ['Messaging channels', 'Telegram, Discord, Slack, Signal, Web', 'Slack, Telegram, Discord, iMessage', '—', '—'],
    ['Long-term memory', 'Second Brain (SQLite, auto-extract, conflict resolution)', 'Auto memory', 'AGENTS.md', 'GEMINI.md'],
    ['Token budget', 'Daily budget + overrides + live stats', '—', '—', '—'],
    ['Security model', 'Permission modes + blocklist + scopes', 'Sandboxed execution + prompts', 'OS-level sandbox', 'Sandbox profiles'],
    ['MCP external tools', '—', '✓', '✓', '✓'],
    ['IDE surface', 'Built-in workspace (files, git)', 'VS Code, JetBrains, Desktop', 'VS Code, Cursor, Windsurf', 'IDE integrations'],
    ['License', 'MIT', 'Source-available', 'Apache-2.0', 'Apache-2.0'],
  ],
};

export const NOT_YET = [
  { title: 'No MCP yet', body: 'Mercury doesn’t speak the Model Context Protocol today. Skills and ~50 built-in tools cover most ground, and MCP is on the roadmap.' },
  { title: 'No OS-level sandbox', body: 'Safety comes from approvals, a blocklist, and folder scopes. The process itself is not sandboxed, so Ask Me is the default for a reason.' },
  { title: 'Signal skips Windows', body: 'The signal-cli bridge runs natively on Linux, and on macOS with Java 17+. Every other channel works on all three operating systems.' },
];

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Mercury free?',
    a: 'Yes. Mercury is MIT-licensed open source. You bring the model: an API key, your ChatGPT Plus/Pro or GitHub Copilot subscription through OAuth, or a local Ollama model at zero cost. Mercury Cloud is optional.',
  },
  {
    q: 'Where does my data live?',
    a: 'On your machine, in ~/.mercury. Memory is a local SQLite database you can search, pause, or clear, and the agent ships no telemetry. Prompts go only to the model provider you configure. With Ollama Local, nothing leaves your machine.',
  },
  {
    q: 'Could it do something destructive?',
    a: 'In Ask Me mode, every file write, shell command, push, and scope change waits for your approval. Commands like sudo and rm -rf / are on a blocklist that never executes in any mode. Reads and writes are scoped to the folders you allow, and bots fail closed.',
  },
  {
    q: 'How is it different from Claude Code or Codex?',
    a: 'Those are coding sessions you open and close. Mercury is a personal agent that stays running: it has memory, schedules, persistent bots, and chat channels. It also includes Mercury Code, a full coding environment, for when you need one.',
  },
  {
    q: 'Which platforms does it run on?',
    a: 'macOS, Linux, and Windows, as standalone binaries or through npm (Node.js 20+). It also runs on Android via Termux and on any cloud VM.',
  },
  {
    q: 'Does it support MCP?',
    a: 'Not yet. Mercury uses its own skills, based on the Agent Skills spec with 126+ in the registry, plus ~50 built-in tools. MCP support is on the roadmap.',
  },
];
