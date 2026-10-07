import React, { useEffect, useRef, useState } from 'react';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import Killipi from '@site/src/components/Killipi';
import '@site/src/css/landing.css';

/**
 * Hero demo script (Web ⇄ Terminal ⇄ Chat switcher).
 * The sync-working / sync-complete markers drive the glyph's live state
 * machine through window.mercuryGlyph — mascot and proof surface act as
 * one system (Pi playbook, v3 blueprint §2).
 */
type TerminalLine = {
  type:
    | 'prompt' | 'input' | 'tool' | 'output' | 'status' | 'agent' | 'stream'
    | 'autopilot' | 'completion' | 'sync-working' | 'sync-complete' | 'gap';
  text: string;
};

const heroLines: TerminalLine[] = [
  { type: 'prompt', text: '> ' },
  { type: 'input', text: 'refactor the auth module to use JWT and add tests' },
  { type: 'status', text: '  ⚙️ Mercury working (step 1)' },
  { type: 'tool', text: '  ✅ read_file · src/auth/handler.ts' },
  { type: 'tool', text: '  ✅ read_file · src/auth/middleware.ts' },
  { type: 'tool', text: '  ✅ edit_file · src/auth/handler.ts' },
  { type: 'tool', text: '  ✅ create_file · src/auth/jwt.ts' },
  { type: 'tool', text: '  ✅ create_file · tests/auth.test.ts' },
  { type: 'tool', text: '  ✅ run_command · npm test' },
  { type: 'output', text: '  Tests: 8 passed, 0 failed' },
  { type: 'completion', text: '  ✅ Task complete (6 steps · 34s) · claude-sonnet · 8.2k tokens' },
  { type: 'agent', text: 'Mercury: ' },
  { type: 'stream', text: 'Done. Replaced session-based auth with JWT. Created jwt.ts with sign/verify helpers and added 8 tests covering token generation, expiry, and middleware validation.' },
];

const multiAgentLines: TerminalLine[] = [
  { type: 'prompt', text: '> ' },
  { type: 'input', text: 'research the best pagination strategies, then implement cursor-based pagination for our API' },
  { type: 'output', text: '  🤖 Multi-agent mode activated.' },
  { type: 'sync-working', text: '  ⚙️ a1 × a2 running in parallel' },
  { type: 'output', text: '  Agent a1: researching pagination strategies' },
  { type: 'output', text: '  Agent a2: implementing cursor-based pagination' },
  { type: 'tool', text: '  🔄 a1: fetch_url, fetch_url, read_file' },
  { type: 'sync-working', text: '  ⚙️ a1 comparing strategies · 3 sources' },
  { type: 'tool', text: '  🔄 a2: read_file, edit_file, create_file' },
  { type: 'sync-working', text: '  ⚙️ a2 patching 4 endpoints · running tests' },
  { type: 'tool', text: '  ✅ a2: run_command · npm test — 12 passed' },
  { type: 'completion', text: '  ✅ a1 completed (12.3s) — 3 strategies compared' },
  { type: 'sync-complete', text: '  ✅ a2 completed (18.7s) — cursor pagination added to 4 endpoints' },
  { type: 'agent', text: 'Mercury: ' },
  { type: 'stream', text: 'Both agents are done. a1 found that cursor-based is optimal for our use case (confirmed by a2\'s implementation). Want me to review the changes?' },
];

/* ---- Web view script (dashboard + shared memory, Pi "product surface") ---- */
const webLines: TerminalLine[] = [
  { type: 'output', text: '  ◧ Dashboard · localhost:6174' },
  { type: 'tool', text: '  📊 3 agents online · a1 idle · a2 building API' },
  { type: 'tool', text: '  🧠 Second Brain · 1,204 memories · 12 consolidated today' },
  { type: 'output', text: '  🪶 a2: "JWT refactor done — 8 tests green." You approve the PR.' },
  { type: 'sync-complete', text: '  ✓ Approvals: 2 pending → 1 · memory synced across all agents' },
];

/* ---- Chat view script (Telegram status-card pattern) ---- */
const chatLines: TerminalLine[] = [
  { type: 'input', text: 'status?' },
  { type: 'output', text: '  📌 Status card (pinned)' },
  { type: 'tool', text: '  🔄 a1 · research: cursor pagination (3 sources)' },
  { type: 'sync-working', text: '  ⚙️ a2 · editing api/routes.ts (+48 −12)' },
  { type: 'sync-complete', text: '  ✅ a2 · cursor pagination live on 4 endpoints' },
  { type: 'stream', text: 'a2 shipped. Review the PR or I can self-check it with Autopilot?' },
];

function typeTerminal(container: HTMLDivElement, lines: TerminalLine[], speed: number) {
  let idx = 0;
  let charIdx = 0;
  let currentSpan: HTMLSpanElement | null = null;

  function nextLine() {
    if (idx >= lines.length) return;
    const line = lines[idx];

    if (line.type === 'prompt') {
      const span = document.createElement('span');
      span.className = 'lp-prompt';
      span.textContent = line.text;
      container.appendChild(span);
      idx++;
      nextLine();
      return;
    }

    if (line.type === 'input') {
      currentSpan = document.createElement('span');
      currentSpan.className = 'lp-input-text';
      container.appendChild(currentSpan);
      charIdx = 0;
      typeChars(line.text, () => {
        container.appendChild(document.createElement('br'));
        idx++;
        nextLine();
      });
      return;
    }

    if (line.type === 'tool') {
      const span = document.createElement('span');
      span.className = 'lp-tool';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 3);
      return;
    }

    if (line.type === 'status') {
      const span = document.createElement('span');
      span.className = 'lp-status';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 2);
      return;
    }

    if (line.type === 'output') {
      const span = document.createElement('span');
      span.className = 'lp-output';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 2);
      return;
    }

    if (line.type === 'autopilot') {
      const span = document.createElement('span');
      span.className = 'lp-autopilot';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 4);
      return;
    }

    /* ---- glyph demo-sync: `working` tempo while agents run, pulse on done ---- */
    if (line.type === 'sync-working') {
      const b = (window as any).mercuryGlyph;
      if (b && b.__holdUntil) b.__holdUntil(Date.now() + speed * 14);
      if (b) b.working();
      const span = document.createElement('span');
      span.className = 'lp-status';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 2);
      return;
    }

    if (line.type === 'sync-complete') {
      const span = document.createElement('span');
      span.className = 'lp-completion';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      const b = (window as any).mercuryGlyph;
      if (b) b.complete();
      setTimeout(nextLine, speed * 5);
      return;
    }

    if (line.type === 'gap') {
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 6);
      return;
    }

    if (line.type === 'completion') {
      const span = document.createElement('span');
      span.className = 'lp-completion';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 3);
      return;
    }

    if (line.type === 'agent') {
      const span = document.createElement('span');
      span.className = 'lp-agent';
      span.textContent = line.text;
      container.appendChild(span);
      idx++;
      nextLine();
      return;
    }

    if (line.type === 'stream') {
      currentSpan = document.createElement('span');
      currentSpan.className = 'lp-stream-text';
      container.appendChild(currentSpan);
      charIdx = 0;
      typeChars(line.text, () => {
        container.appendChild(document.createElement('br'));
        idx++;
        const cursor = document.createElement('span');
        cursor.className = 'lp-cursor';
        container.appendChild(cursor);
      }, speed * 1.2);
      return;
    }

    idx++;
    nextLine();
  }

  function typeChars(text: string, done: () => void, customSpeed?: number) {
    const s = customSpeed || speed;
    if (charIdx >= text.length) {
      done();
      return;
    }
    if (currentSpan) currentSpan.textContent += text[charIdx];
    charIdx++;
    container.scrollTop = container.scrollHeight;
    setTimeout(() => typeChars(text, done, customSpeed), s);
  }

  nextLine();
}

type PmId = 'npm' | 'bun' | 'pnpm' | 'yarn';
type OsId = 'macos' | 'linux' | 'windows';

const PM_BASE: Record<PmId, string> = {
  npm: 'npm i -g @cosmicstack/mercury-agent',
  bun: 'bun add -g @cosmicstack/mercury-agent',
  pnpm: 'pnpm add -g @cosmicstack/mercury-agent',
  yarn: 'yarn global add @cosmicstack/mercury-agent',
};

function pmCommand(pm: PmId, os: OsId): string {
  // PowerShell (default Windows shell) doesn't support `&&` until v7; use `;` to be safe.
  const sep = os === 'windows' ? '; ' : ' && ';
  return `${PM_BASE[pm]}${sep}mercury`;
}

const PM_LABELS: Record<PmId, string> = {
  npm: 'npm',
  bun: 'Bun',
  pnpm: 'pnpm',
  yarn: 'Yarn',
};

const OS_LABELS: Record<OsId, string> = {
  macos: 'macOS',
  linux: 'Linux',
  windows: 'Windows',
};

const RELEASES_BASE = 'https://github.com/cosmicstack-labs/mercury-agent/releases/latest/download';

function detectOs(): OsId {
  if (typeof navigator === 'undefined') return 'macos';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'windows';
  if (ua.includes('mac')) return 'macos';
  return 'linux';
}

function osBinaryAsset(os: OsId): string {
  switch (os) {
    case 'macos':
      return 'mercury-macos-arm64';
    case 'linux':
      return 'mercury-linux-x64';
    case 'windows':
      return 'mercury-win-x64.exe';
  }
}

function osInstallSnippet(os: OsId): string {
  if (os === 'windows') {
    return 'irm https://mercuryagent.sh/install.ps1 | iex';
  }
  return 'curl -fsSL https://mercuryagent.sh/install.sh | sh';
}

function HeroInstall(): React.ReactElement {
  const [pm, setPm] = useState<PmId>('npm');
  const [os, setOs] = useState<OsId>('macos');
  const [copied, setCopied] = useState<'pm' | 'os' | null>(null);

  useEffect(() => {
    setOs(detectOs());
  }, []);

  const pmCmd = pmCommand(pm, os);
  const osCmd = osInstallSnippet(os);
  const binaryAsset = osBinaryAsset(os);
  const binaryUrl = `${RELEASES_BASE}/${binaryAsset}`;
  const prompt = os === 'windows' ? 'PS>' : '$';

  const copy = async (text: string, which: 'pm' | 'os') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(which);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="lp-hero-install" data-os={os}>
      <div className="lp-install-head">
        <div className="lp-install-tabs" role="tablist" aria-label="Package manager">
          {(Object.keys(PM_LABELS) as PmId[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={pm === id}
              className={`lp-install-tab ${pm === id ? 'is-active' : ''}`}
              onClick={() => setPm(id)}
              type="button"
            >
              {PM_LABELS[id]}
            </button>
          ))}
        </div>
        <div className="lp-install-os" role="tablist" aria-label="Operating system">
          {(Object.keys(OS_LABELS) as OsId[]).map((id) => (
            <button
              key={id}
              role="tab"
              aria-selected={os === id}
              className={`lp-install-pill ${os === id ? 'is-active' : ''}`}
              onClick={() => setOs(id)}
              type="button"
            >
              {OS_LABELS[id]}
            </button>
          ))}
        </div>
      </div>

      <div className="lp-install-block lp-install-block-primary">
        <div className="lp-install-block-label">
          <span className="lp-install-block-num">1</span>
          Install with {PM_LABELS[pm]} on {OS_LABELS[os]}
        </div>
        <div className="lp-install-cmd">
          <span className="lp-install-prompt">{prompt}</span>
          <code>{pmCmd}</code>
          <button
            type="button"
            className="lp-install-copy"
            onClick={() => copy(pmCmd, 'pm')}
            aria-label="Copy install command"
          >
            {copied === 'pm' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
      </div>

      <div className="lp-install-block lp-install-block-alt">
        <div className="lp-install-block-label">
          Or install the standalone binary
          <span className="lp-install-block-hint">· no Node.js required</span>
        </div>
        <div className="lp-install-cmd">
          <span className="lp-install-prompt">{prompt}</span>
          <code>{osCmd}</code>
          <button
            type="button"
            className="lp-install-copy"
            onClick={() => copy(osCmd, 'os')}
            aria-label="Copy installer command"
          >
            {copied === 'os' ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <div className="lp-install-actions">
          <a className="lp-install-binary" href={binaryUrl} rel="noopener">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download <code className="lp-install-binary-asset">{binaryAsset}</code>
          </a>
        </div>
      </div>
    </div>
  );
}

/**
 * HeroDemo — v3 interactive proof surface (Web ⇄ Terminal ⇄ Chat).
 * Switcher tabs remap the hero from "watch a terminal" to "see the product
 * from every surface". Terminal tab types the multi-agent script live and
 * drives the glyph via the mercuryGlyph bus; Web and Chat are faithful mocks
 * of the dashboard and Telegram status card.
 */
function HeroDemo({ termRef, initial = 'terminal' }: { termRef: React.RefObject<HTMLDivElement | null>; initial?: string }): React.ReactElement {
  const [tab, setTab] = useState(initial);

  const tabs: { id: string; label: string; ico: string; note: string }[] = [
    { id: 'web', label: 'Web Dashboard', ico: '◧', note: 'Dashboard at localhost:6174 · dark UI' },
    { id: 'terminal', label: 'Terminal', ico: '>_', note: 'mercury · parallel agents · sync with glyph' },
    { id: 'chat', label: 'Telegram', ico: '✈', note: 'One pinned status card · ephemeral prompts' },
  ];

  return (
    <div className="lp-hero-demo-wrap">
      <div className="lp-demo-tabs" role="tablist" aria-label="Product surface switcher">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`lp-demo-tab ${tab === t.id ? 'is-active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="lp-demo-tab-ico">{t.ico}</span>
            {t.label}
          </button>
        ))}
      </div>
      <div className="lp-hero-demo">
        {tab === 'terminal' && (
          <div className="lp-terminal-window" style={{ border: 'none', boxShadow: 'none' }}>
            <div className="lp-terminal-bar">
              <span className="lp-terminal-dot lp-dot-red" />
              <span className="lp-terminal-dot lp-dot-yellow" />
              <span className="lp-terminal-dot lp-dot-green" />
              <span className="lp-terminal-title">mercury — multi-agent</span>
            </div>
            <div className="lp-terminal-body" ref={termRef} />
          </div>
        )}
        {tab === 'web' && (
          <div className="lp-hero-demo-note">Dashboard at localhost:6174 · agents, memory, approvals in one dark console</div>
        )}
        {tab === 'chat' && (
          <div className="lp-hero-chat">
            <div className="lp-chat-join">
              <span className="lp-join-chip">mercury</span> telegram · dm
            </div>
            <div className="lp-chat-msg lp-chat-msg-user">
              <span className="lp-chat-who">you · 14:02</span>
              <div className="lp-chat-bubble">status?</div>
            </div>
            <div className="lp-chat-msg lp-chat-msg-mercury">
              <span className="lp-chat-who lp-chat-who-is-mercury">mercury · 14:02</span>
              <div className="lp-chat-bubble">
                📌 Status card (pinned)
                <div className="lp-chat-chips">
                  <span className="lp-chat-chip lp-chat-chip-ok">✅ a1 · research done (3 sources)</span>
                  <span className="lp-chat-chip lp-chat-chip-work">🔄 a2 · editing api/routes.ts</span>
                  <span className="lp-chat-chip lp-chat-chip-warn">⏸ 1 approval pending</span>
                </div>
              </div>
            </div>
            <div className="lp-chat-msg lp-chat-msg-mercury">
              <span className="lp-chat-who lp-chat-who-is-mercury">mercury · 14:03</span>
              <div className="lp-chat-bubble">a2 shipped cursor pagination on 4 endpoints. Review the PR or should I self-check with Autopilot?</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function LandingPage(): React.ReactElement {
  const demoTermRef = useRef<HTMLDivElement>(null);
  const [ghStars, setGhStars] = React.useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    fetch('https://api.github.com/repos/cosmicstack-labs/mercury-agent')
      .then(r => r.json())
      .then(data => {
        if (data.stargazers_count != null) {
          const n = data.stargazers_count;
          setGhStars(n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
        }
      })
      .catch(() => { });
  }, []);

  useEffect(() => {
    const demoEl = demoTermRef.current;
    if (!demoEl) return;

    const demoObs = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            demoObs.unobserve(entry.target);
            typeTerminal(demoEl, multiAgentLines, 20);
          }
        });
      },
      { threshold: 0.3 }
    );

    demoObs.observe(demoEl);

    return () => {
      demoObs.disconnect();
    };
  }, []);

  useEffect(() => {
    const reveals = document.querySelectorAll('.lp-reveal');
    const observer = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            entry.target.classList.add('lp-revealed');
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );
    reveals.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <Head>
        <title>Mercury Agent — Soul-driven AI Agent with Permission-Hardened Tools</title>
        <meta name="description" content="Mercury Agent — a soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access. Runs 24/7 from CLI, Web, Telegram, Discord, Slack, or Signal." />
        <meta property="og:title" content="Mercury Agent — Soul-driven AI Agent with Permission-Hardened Tools" />
        <meta property="og:description" content="Soul-driven AI agent with permission-hardened tools, token budgets, and multi-channel access. Runs 24/7 from CLI, Web, Telegram, Discord, Slack, or Signal." />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Mercury Agent — Soul-driven" />
        <meta property="og:url" content="https://mercuryagent.sh" />
        <meta property="og:image" content="https://mercuryagent.sh/img/og/home.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@mercuryagent" />
        <meta name="twitter:title" content="Mercury Agent — Soul-driven AI Agent with Permission-Hardened Tools" />
        <meta name="twitter:description" content="Soul-driven AI agent · Permission-hardened tools · Token budgets · Multi-channel access · 24/7 from CLI, Web, Telegram, Discord, Slack, or Signal." />
        <meta name="twitter:image" content="https://mercuryagent.sh/img/og/home.png" />
        <link rel="canonical" href="https://mercuryagent.sh/" />
      </Head>

      <div className="lp-page">
        {/* Navigation */}
        <nav className="lp-nav">
          <div className="lp-nav-inner">
            <Link to="/" className="lp-nav-logo">
              <img src="/img/logo-dark.png" alt="Mercury Agent" className="lp-nav-logo-img" />
              Mercury Agent
            </Link>
            <div className={`lp-nav-links ${mobileMenuOpen ? 'lp-nav-links-open' : ''}`}>
              <Link to="/cloud" onClick={() => setMobileMenuOpen(false)}>Mercury Cloud</Link>
              <Link to="/#pillars" onClick={() => setMobileMenuOpen(false)}>Features</Link>
              <Link to="/#live-demo" onClick={() => setMobileMenuOpen(false)}>Demo</Link>
              <Link to="/#channels" onClick={() => setMobileMenuOpen(false)}>Channels</Link>
              <Link to="/#skills" onClick={() => setMobileMenuOpen(false)}>Skills</Link>
              <Link to="/#agents" onClick={() => setMobileMenuOpen(false)}>Multi-Agent</Link>
              <Link to="/#compare" onClick={() => setMobileMenuOpen(false)}>Compare</Link>
              <Link to="/docs" onClick={() => setMobileMenuOpen(false)}>Docs</Link>
            </div>
            <div className="lp-nav-right">
              <a href="https://github.com/cosmicstack-labs/mercury-agent" className="lp-github-btn" target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
                {ghStars && <span className="lp-github-btn-count">{ghStars}</span>}
              </a>
              <button className="lp-nav-toggle" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">☰</button>
            </div>
          </div>
        </nav>

        {/* Hero — v3: no mesh, no glow. Glyph + switcher + live proof surface. */}
        <section className="lp-hero">
          <div className="lp-container lp-hero-content">
            <Killipi />
            <div className="lp-hero-eyebrow" aria-label="Mercury Agent — Soul-driven">
              <span className="lp-hero-eyebrow-mark">☿</span>
              <span className="lp-hero-eyebrow-text">Mercury Agent · Soul-driven</span>
              <span className="lp-hero-eyebrow-badge">v1.3.0 · Mercury Bots</span>
            </div>
            <h1 className="lp-hero-title">
              Soul-driven AI agent<br />
              <span className="lp-hero-highlight">with permission-hardened tools.</span>
            </h1>
            <p className="lp-hero-sub">
              A <strong>soul-driven</strong> agent with Second Brain memory, a full Skill System, Token Saver Mode,
              multi-agent orchestration, 40+ permission-hardened tools, and standalone binaries on every major OS.
              Runs 24/7 from your terminal, browser, Telegram, Discord, Slack, or Signal.
            </p>
            <div className="lp-hero-actions">
              <Link to="/cloud" className="lp-btn lp-btn-primary">Try Mercury Cloud</Link>
              <a href="#live-demo" className="lp-btn lp-btn-secondary">See It Work</a>
              <Link to="/docs/releases/1.3.0" className="lp-btn lp-btn-ghost">What's new in 1.3.0 →</Link>
            </div>
            <HeroInstall />
          </div>
        </section>

        {/* Mercury 1.3.0 Release Banner */}
        <section id="mercury-bots" className="lp-section">
          <div className="lp-container">
            <div className="lp-release-banner lp-reveal">
              <div className="lp-release-banner-left">
                <div className="lp-release-badge">☿ NEW RELEASE</div>
                <h2 className="lp-release-title">Mercury 1.3.0 — <em>Mercury Bots</em></h2>
                <p className="lp-release-lead">
                  The release where Mercury <strong>stops being one agent and becomes a fleet</strong>.
                  Mercury Bots are persistent specialist agents — each with its own persona, model, memory,
                  and permissions — that run <strong>outside the conversation</strong>. Fleet leads carry crews,
                  jobs flow through a durable queue, output lands in the bot's own cockpit thread, and whole
                  teams export as shareable bundles.
                </p>
                <div className="lp-release-points">
                  <span>✓ Persistent bots — persona, model, memory, permissions</span>
                  <span>✓ Fleet leads + crews with a shared workspace</span>
                  <span>✓ Durable job queue + replayable DLQ</span>
                  <span>✓ Cockpit threads, journals, and bundle export</span>
                </div>
                <div className="lp-release-actions">
                  <Link to="/docs/releases/1.3.0" className="lp-btn lp-btn-primary">Release notes →</Link>
                  <Link to="/docs/integrations/mercury-bots" className="lp-btn lp-btn-ghost">Bots guide</Link>
                </div>
              </div>
              <div className="lp-release-right">
                <div className="lp-release-term">
                  <div className="lp-release-term-line lp-dim">● MERCURY · dispatching the fleet</div>
                  <div className="lp-release-term-line">  ✓ ⚡ article-writer drafted notes <span className="lp-dim">· 620 words</span></div>
                  <div className="lp-release-term-line">  ✓ ⚑ fact-checker verified <span className="lp-ok">14/14 sourced</span></div>
                  <div className="lp-release-term-line">  ✓ ✒ voice-editor humanized <span className="lp-dim">· AI-flavor 0</span></div>
                  <div className="lp-release-term-line">  ✓ ☁ dispatch-controller queued <span className="lp-dim">· publish 09:00</span></div>
                  <div className="lp-release-term-line lp-ok">─ Bots idle · journals clean · fleet verified</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Mercury Cloud Hero Banner */}
        <section id="cloud" className="lp-section lp-section-cloud">
          <div className="lp-container">
            <div className="lp-cloud-banner lp-reveal">
              <div className="lp-cloud-banner-left">
                <div className="lp-cloud-badge">☁ New in 1.2.0</div>
                <h2 className="lp-cloud-title">Mercury Cloud</h2>
                <p className="lp-cloud-lead">
                  Pair from the terminal. Stay online forever. Mercury Cloud is a hosted backend that
                  keeps your agent reachable over a persistent WebSocket — no port forwarding, no
                  reverse proxy, no certificates. Auto-rotating JWTs, long-lived agent API keys for
                  headless self-recovery, and a shared memory pool across all your agents.
                </p>
                <div className="lp-cloud-actions">
                  <Link to="/cloud" className="lp-btn lp-btn-primary">Explore Mercury Cloud →</Link>
                  <Link to="/docs/releases/1.2.0" className="lp-btn lp-btn-ghost">Release notes</Link>
                </div>
              </div>
              <div className="lp-cloud-banner-right">
                <div className="lp-cloud-features">
                  <div className="lp-cloud-feature">
                    <span className="lp-cloud-feature-icon">⚡</span>
                    <div>
                      <h4>Plug-and-play setup</h4>
                      <p>One command pairs your agent. No servers, no ports, no DNS.</p>
                    </div>
                  </div>
                  <div className="lp-cloud-feature">
                    <span className="lp-cloud-feature-icon">🔒</span>
                    <div>
                      <h4>Self-healing auth</h4>
                      <p>JWT + refresh + agent API key. Stays online even after token death.</p>
                    </div>
                  </div>
                  <div className="lp-cloud-feature">
                    <span className="lp-cloud-feature-icon">🧠</span>
                    <div>
                      <h4>Shared memory pool</h4>
                      <p>Search across all your agents' memories from the cloud.</p>
                    </div>
                  </div>
                  <div className="lp-cloud-feature">
                    <span className="lp-cloud-feature-icon">🎛️</span>
                    <div>
                      <h4>Remote dashboard</h4>
                      <p>Manage agents, install skills, and monitor from the browser.</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Three Pillars */}
        <section id="pillars" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Built Different</h2>
            <p className="lp-section-sub">The AI agent that <strong>thinks, acts, and asks.</strong> Three principles that define Mercury.</p>
            <div className="lp-pillars">
              <div className="lp-pillar lp-reveal">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></svg>
                </div>
                <h3>Thinks</h3>
                <p className="lp-pillar-lead">Mercury doesn't just execute. It orchestrates.</p>
                <ul>
                  <li>Spawns parallel sub-agents for concurrent tasks</li>
                  <li>Mercury Autopilot detects stuck loops by analyzing parameter diversity and success rates</li>
                  <li>AI self-check in Allow All mode — the model evaluates its own progress</li>
                  <li>25-step agentic loop with graduated escalation</li>
                </ul>
              </div>
              <div className="lp-pillar lp-reveal">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
                </div>
                <h3>Acts</h3>
                <p className="lp-pillar-lead">40+ built-in tools. Zero configuration.</p>
                <ul>
                  <li>Filesystem, shell, git, GitHub PRs and issues</li>
                  <li>Spotify playback, search, playlists, and DJ mode</li>
                  <li>Markdown skill system with scheduling and elevation</li>
                  <li>Real-time progress with completion banners and token stats</li>
                </ul>
              </div>
              <div className="lp-pillar lp-reveal">
                <div className="lp-pillar-icon">
                  <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>
                </div>
                <h3>Asks</h3>
                <p className="lp-pillar-lead">Full control. Nothing happens without your say.</p>
                <ul>
                  <li>Ask Me mode: prompts for every write, command, and scope change</li>
                  <li>Allow All mode: auto-approve with AI self-monitoring</li>
                  <li>Safe command whitelist — reads never prompt</li>
                  <li>Directory scoping with per-session memory</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Live Demo — v3: product lifecycle strip (Ask → Working → Deliver → Remember) */}
        <section id="live-demo" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">One Task, End to End</h2>
            <p className="lp-section-sub">The full loop: you ask, agents work in parallel, work is delivered, and the outcome is remembered.</p>
            <div className="lp-lifecycle lp-reveal">
              <div className="lp-lifecycle-card">
                <div className="lp-lifecycle-num">01</div>
                <h3>You Ask</h3>
                <p>From any of six channels — CLI, Web, Telegram, Discord, Slack, or Signal. One task in.</p>
                <ul>
                  <li>Status card appears instantly</li>
                  <li>Plan preview before any write</li>
                </ul>
              </div>
              <div className="lp-lifecycle-card">
                <div className="lp-lifecycle-num">02</div>
                <h3>Agents Work</h3>
                <p>Parallel sub-agents with file locks. Autopilot watches for loops while they run.</p>
                <ul>
                  <li>Tool calls streamed in place</li>
                  <li>Loop detection: productive vs stuck</li>
                </ul>
              </div>
              <div className="lp-lifecycle-card">
                <div className="lp-lifecycle-num">03</div>
                <h3>Work Delivers</h3>
                <p>Completion banner with evidence: steps, tokens, tests. No fake "task complete".</p>
                <ul>
                  <li>Verified verdicts, not claims</li>
                  <li>Honest blockovers when paused</li>
                </ul>
              </div>
              <div className="lp-lifecycle-card">
                <div className="lp-lifecycle-num">04</div>
                <h3>It Remembers</h3>
                <p>Outcomes consolidate into the Second Brain — next task starts smarter, not from zero.</p>
                <ul>
                  <li>Conflict-resolved memory</li>
                  <li>Patterns surface automatically</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Soul — v3: first-person voice + values (Pi "product persona" surface) */}
        <section id="task-flow" className="lp-section">
          <div className="lp-container">
            <div className="lp-soul-grid lp-reveal">
              <div className="lp-soul-quote">
                <p>
                  <span className="lp-soul-mark">☿</span> "I keep a second brain so you don't have to.
                  Nothing runs without your say. Ask me from six places."
                </p>
                <div className="lp-soul-src">FROM THE SOUL FILES · SOUL.MD</div>
              </div>
              <div className="lp-soul-cards">
                <div className="lp-soul-card">
                  <h4>Loyalty</h4>
                  <p>Your interests above all — the agent works for you, not the tooling.</p>
                </div>
                <div className="lp-soul-card">
                  <h4>Honesty</h4>
                  <p>Verdicts, not vibes. A task is done when it's verified, not when it's said.</p>
                </div>
                <div className="lp-soul-card">
                  <h4>Curiosity</h4>
                  <p>Every interaction feeds the Second Brain. Mercury gets sharper with use.</p>
                </div>
                <div className="lp-soul-card">
                  <h4>Efficiency</h4>
                  <p>Token budgets, compaction, autopilot loop detection. No wasted motion.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Channels — CLI + Web + Telegram + Discord + Slack + Signal */}
        <section id="channels" className="lp-section lp-section-alt">
          <div className="lp-container">
            <h2 className="lp-section-title">Six Channels, One Agent</h2>
            <p className="lp-section-sub">Same capabilities. Different interfaces. All real-time.</p>
            <div className="lp-channels-grid lp-reveal">
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">{'>'}_</span>
                  <h3>CLI</h3>
                </div>
                <ul>
                  <li>Ink-based TUI with live progress view</li>
                  <li>Slash command autocomplete with arrow navigation</li>
                  <li>Workspace IDE mode with file explorer and git panel</li>
                  <li>Keyboard shortcuts: Ctrl+B (background), Ctrl+D (log), Ctrl+P (plan)</li>
                  <li>Multi-line input, input history, streaming output</li>
                  <li>Interactive Spotify player with seek and volume</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">◧</span>
                  <h3>Web Dashboard</h3>
                </div>
                <ul>
                  <li>React SPA at localhost:6174 with dark/light theme</li>
                  <li>Chat interface with real-time SSE streaming</li>
                  <li>Kanban boards with agent-powered card execution</li>
                  <li>Second Brain visualization with memory graph</li>
                  <li>Workspace IDE with file tree and git integration</li>
                  <li>Provider, skill, schedule, and permission management</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">✈</span>
                  <h3>Telegram</h3>
                </div>
                <ul>
                  <li>Single pinned status card — one message shows all progress</li>
                  <li>Ephemeral permission prompts (auto-deleted after response)</li>
                  <li>15 bot commands registered in the menu</li>
                  <li>Inline keyboards for permissions and mode selection</li>
                  <li>File uploads with auto-type detection</li>
                  <li>Organization access model with admin/member roles</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🎮</span>
                  <h3>Discord</h3>
                </div>
                <ul>
                  <li>Full bot integration with slash commands</li>
                  <li>Channel-scoped or DM conversations</li>
                  <li>Organization access with admin roles and pairing codes</li>
                  <li>Streaming responses with in-place edits</li>
                  <li>Embeds for rich task progress and completion banners</li>
                  <li>Rate-limiting and busy detection for shared servers</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">#</span>
                  <h3>Slack</h3>
                </div>
                <ul>
                  <li>Socket Mode bot — no public endpoint needed</li>
                  <li>Channel and DM support with thread awareness</li>
                  <li>Organization access with admin/member roles</li>
                  <li>Streaming responses via message edits</li>
                  <li>Slash command /mercury for quick interactions</li>
                  <li>App mentions and message events for natural conversation</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🔒</span>
                  <h3>Signal</h3>
                </div>
                <ul>
                  <li>End-to-end encrypted via signal-cli bridge</li>
                  <li>Group mode (Mercury group) or private DM mode</li>
                  <li>Pairing code flow for secure onboarding</li>
                  <li>Auto-managed signal-cli binary (download + register)</li>
                  <li>Rate-limiting and dedup for reliable message handling</li>
                  <li>Runs on Linux and macOS (arm64 / x64)</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Skills Registry */}
        <section id="skills" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Skills Registry</h2>
            <p className="lp-section-sub">
              Install vetted, single-purpose capabilities from <a href="https://skills.mercuryagent.sh" target="_blank" rel="noopener noreferrer">skills.mercuryagent.sh</a> — 126+ skills across 23 categories. Review the source, then install with one command.
            </p>

            <div className="lp-channels-grid lp-reveal" style={{ marginTop: '2rem' }}>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">{'>'}_</span>
                  <h3>From the CLI</h3>
                </div>
                <div className="lp-terminal-inline" style={{ marginBottom: '0.75rem' }}>
                  <code>mercury skills search contract</code>
                </div>
                <div className="lp-terminal-inline" style={{ marginBottom: '0.75rem' }}>
                  <code>mercury skills view finance-legal/contract-review</code>
                </div>
                <div className="lp-terminal-inline">
                  <code>mercury skills install finance-legal/contract-review</code>
                </div>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">◧</span>
                  <h3>From the Dashboard</h3>
                </div>
                <ul>
                  <li>Open <strong>Skills</strong> in the sidebar at <code>localhost:6174</code>.</li>
                  <li>Paste <code>category/slug</code> into the registry installer.</li>
                  <li>Toggle skills on/off without removing them.</li>
                  <li>Or use the URL installer for raw <code>SKILL.md</code> files.</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">✈</span>
                  <h3>From Telegram</h3>
                </div>
                <ul>
                  <li><code>/skills</code> — list installed skills</li>
                  <li><code>/skills search &lt;query&gt;</code> — search the registry</li>
                  <li><code>/skills view &lt;id&gt;</code> — show details + registry URL</li>
                  <li><code>/skills install &lt;id&gt;</code> — admin only</li>
                </ul>
              </div>
            </div>

            <div style={{ textAlign: 'center', marginTop: '2.5rem' }}>
              <a
                href="https://skills.mercuryagent.sh"
                target="_blank"
                rel="noopener noreferrer"
                className="lp-btn lp-btn-primary"
              >
                Browse the registry →
              </a>{' '}
              <Link to="/docs/reference/skills" className="lp-btn lp-btn-secondary">
                Read the docs
              </Link>
            </div>
          </div>
        </section>

        {/* Multi-Agent + product demo switcher (Web ⇄ Terminal ⇄ Chat) */}
        <section id="agents" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">Multi-Agent Orchestration</h2>
            <p className="lp-section-sub">Mercury spawns parallel agents. You keep chatting. Switch surfaces to see the same task from every side.</p>

            {/* v3 demo switcher: three surfaces, one glyph-synced state machine */}
            <HeroDemo
              termRef={demoTermRef}
              initial="terminal"
            />
            <div className="lp-agent-features lp-reveal">
              {[
                { title: 'Parallel Execution', desc: 'Multiple tasks run simultaneously in isolated context windows.' },
                { title: 'File Locks', desc: 'Reader-writer locks prevent concurrent write conflicts between agents.' },
                { title: 'Resource-Aware', desc: 'Max concurrent agents auto-detected from CPU and RAM.' },
                { title: 'Non-Blocking', desc: 'Keep chatting while agents work. Get notified when they finish.' },
              ].map((f, i) => (
                <div key={i} className="lp-agent-feature">
                  <h4>{f.title}</h4>
                  <p>{f.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Mercury Autopilot */}
        <section id="autopilot" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Mercury Autopilot</h2>
            <p className="lp-section-sub">Intelligent loop detection that knows the difference between working hard and going in circles.</p>
            <div className="lp-autopilot-grid lp-reveal">
              <div className="lp-autopilot-card">
                <div className="lp-autopilot-verdict lp-verdict-productive">Productive</div>
                <p>High parameter diversity ({'>'} 60%) and success rate ({'>'} 70%). Mercury continues without interruption.</p>
              </div>
              <div className="lp-autopilot-card">
                <div className="lp-autopilot-verdict lp-verdict-suspicious">Suspicious</div>
                <p>Moderate repetition detected. In Allow All: AI self-check evaluates progress. In Ask Me: prompts you.</p>
              </div>
              <div className="lp-autopilot-card">
                <div className="lp-autopilot-verdict lp-verdict-stuck">Stuck</div>
                <p>Low diversity and high failure rate. Mercury stops the current execution path automatically.</p>
              </div>
            </div>
          </div>
        </section>

        {/* Second Brain */}
        <section id="memory" className="lp-section lp-section-alt">
          <div className="lp-container">
            <h2 className="lp-section-title">Second Brain</h2>
            <p className="lp-section-sub">Mercury remembers — modeled after the conscious and subconscious mind.</p>

            {/* Split brain diagram */}
            <div className="lp-brain-diagram lp-reveal" style={{ display: 'flex', justifyContent: 'center', margin: '3rem 0' }}>
              <svg viewBox="0 0 440 320" width="440" height="320" style={{ maxWidth: '100%' }}>
                {/* Brain outline — left hemisphere (Conscious) */}
                <path
                  d="M220 40 C160 40, 60 80, 60 180 C60 260, 140 290, 220 290"
                  fill="rgba(236, 72, 153, 0.06)" stroke="rgba(236, 72, 153, 0.5)" strokeWidth="2"
                />
                {/* Brain outline — right hemisphere (Subconscious) */}
                <path
                  d="M220 40 C280 40, 380 80, 380 180 C380 260, 300 290, 220 290"
                  fill="rgba(99, 102, 241, 0.06)" stroke="rgba(99, 102, 241, 0.5)" strokeWidth="2"
                />
                {/* Center divider */}
                <line x1="220" y1="40" x2="220" y2="290" stroke="rgba(148, 163, 184, 0.3)" strokeWidth="1" strokeDasharray="4 3" />

                {/* Left label — Conscious */}
                <text x="140" y="150" textAnchor="middle" fill="rgba(236, 72, 153, 0.9)" fontSize="14" fontFamily="monospace" fontWeight="bold">CONSCIOUS</text>
                <text x="140" y="170" textAnchor="middle" fill="rgba(236, 72, 153, 0.6)" fontSize="10" fontFamily="monospace">active memory</text>
                <text x="140" y="195" textAnchor="middle" fill="rgba(236, 72, 153, 0.5)" fontSize="9" fontFamily="monospace">current reasoning</text>
                <text x="140" y="210" textAnchor="middle" fill="rgba(236, 72, 153, 0.5)" fontSize="9" fontFamily="monospace">immediate recall</text>
                <text x="140" y="225" textAnchor="middle" fill="rgba(236, 72, 153, 0.5)" fontSize="9" fontFamily="monospace">working context</text>

                {/* Right label — Subconscious */}
                <text x="300" y="150" textAnchor="middle" fill="rgba(99, 102, 241, 0.9)" fontSize="14" fontFamily="monospace" fontWeight="bold">SUBCONSCIOUS</text>
                <text x="300" y="170" textAnchor="middle" fill="rgba(99, 102, 241, 0.6)" fontSize="10" fontFamily="monospace">long-term recall</text>
                <text x="300" y="195" textAnchor="middle" fill="rgba(99, 102, 241, 0.5)" fontSize="9" fontFamily="monospace">patterns &amp; habits</text>
                <text x="300" y="210" textAnchor="middle" fill="rgba(99, 102, 241, 0.5)" fontSize="9" fontFamily="monospace">learned preferences</text>
                <text x="300" y="225" textAnchor="middle" fill="rgba(99, 102, 241, 0.5)" fontSize="9" fontFamily="monospace">contextual retrieval</text>

                {/* Title at top */}
                <text x="220" y="25" textAnchor="middle" fill="rgba(148, 163, 184, 0.8)" fontSize="11" fontFamily="monospace" fontWeight="bold">MERCURY SECOND BRAIN</text>

                {/* Animated data nodes — conscious side */}
                <circle cx="110" cy="130" r="3" fill="rgba(236, 72, 153, 0.6)"><animate attributeName="opacity" values="0.4;1;0.4" dur="2s" repeatCount="indefinite" /></circle>
                <circle cx="160" cy="240" r="2.5" fill="rgba(236, 72, 153, 0.5)"><animate attributeName="opacity" values="0.3;0.8;0.3" dur="2.5s" repeatCount="indefinite" /></circle>
                <circle cx="90" cy="200" r="2" fill="rgba(236, 72, 153, 0.4)"><animate attributeName="opacity" values="0.5;1;0.5" dur="3s" repeatCount="indefinite" /></circle>

                {/* Animated data nodes — subconscious side */}
                <circle cx="330" cy="130" r="3" fill="rgba(99, 102, 241, 0.6)"><animate attributeName="opacity" values="0.3;0.9;0.3" dur="3s" repeatCount="indefinite" /></circle>
                <circle cx="280" cy="240" r="2.5" fill="rgba(99, 102, 241, 0.5)"><animate attributeName="opacity" values="0.5;1;0.5" dur="2.2s" repeatCount="indefinite" /></circle>
                <circle cx="350" cy="200" r="2" fill="rgba(99, 102, 241, 0.4)"><animate attributeName="opacity" values="0.4;0.8;0.4" dur="2.8s" repeatCount="indefinite" /></circle>

                {/* Connection lines crossing hemispheres */}
                <line x1="170" y1="240" x2="270" y2="130" stroke="rgba(148, 163, 184, 0.15)" strokeWidth="1"><animate attributeName="opacity" values="0.1;0.3;0.1" dur="4s" repeatCount="indefinite" /></line>
                <line x1="160" y1="130" x2="280" y2="240" stroke="rgba(148, 163, 184, 0.15)" strokeWidth="1"><animate attributeName="opacity" values="0.15;0.35;0.15" dur="3.5s" repeatCount="indefinite" /></line>
              </svg>
            </div>

            <div className="lp-brain-grid">
              {[
                { title: 'Conscious Mind', desc: 'Active working memory — facts Mercury is currently reasoning about and can immediately surface in conversation.' },
                { title: 'Subconscious Mind', desc: 'Long-term recall — memories stored persistently and retrieved automatically when contextually relevant.' },
                { title: 'Resolves Conflicts', desc: 'When Mercury detects a contradiction, the higher-confidence memory wins. No stale data.' },
                { title: 'Auto-Consolidation', desc: 'Hourly synthesis of profile summaries and reflections from detected patterns across memory layers.' },
                { title: 'Person Tracking', desc: 'Tracks people you mention with alias resolution, relationship mapping, and graph visualization.' },
                { title: 'Fully Local', desc: 'All data stays on your machine in SQLite. /memory gives you overview, search, pause, and clear.' },
              ].map((c, i) => (
                <div key={i} className="lp-brain-card lp-reveal">
                  <h3>{c.title}</h3>
                  <p>{c.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Providers */}
        <section id="providers" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">Any Provider. Automatic Fallback.</h2>
            <p className="lp-section-sub">Configure one or stack them all. Mercury falls back automatically and tracks which provider last succeeded.</p>
            <div className="lp-provider-grid lp-reveal">
              {[
                { name: 'Mercury Cloud', desc: 'Hosted backend with plug-and-play pairing. Auto-rotating JWTs, shared memory pool, remote dashboard.', badge: 'NEW' },
                { name: 'ChatGPT Web', desc: 'Use your ChatGPT Plus/Pro subscription. OAuth login, no API key.', badge: 'NEW' },
                { name: 'GitHub Copilot', desc: 'Your Copilot subscription — access OpenAI, Anthropic, and Google models.', badge: 'NEW' },
                { name: 'DeepSeek', desc: 'Cost-effective with strong reasoning. Default provider.' },
                { name: 'OpenAI', desc: 'GPT-4o-mini, GPT-4o, o3. Industry standard.' },
                { name: 'Anthropic', desc: 'Claude Sonnet, Haiku, Opus. Nuanced reasoning.' },
                { name: 'Grok (xAI)', desc: "xAI's models via OpenAI-compatible endpoint." },
                { name: 'Ollama Cloud', desc: 'Remote Ollama models via API. No local setup.' },
                { name: 'Ollama Local', desc: 'On your machine. Zero cost, fully private.' },
                { name: 'Atomic Chat', desc: 'Local models via Atomic Chat OpenAI-compatible API.' },
              ].map((p, i) => (
                <div key={i} className="lp-provider-card">
                  <h4>{p.name} {(p as any).badge && <span className="lp-provider-badge">{(p as any).badge}</span>}</h4>
                  <p>{p.desc}</p>
                </div>
              ))}
            </div>
            <div className="lp-provider-note">
              <p>API key or OAuth — your choice. ChatGPT Web and GitHub Copilot authenticate through your browser. Switch models mid-session with <code>/models use</code>.</p>
            </div>
          </div>
        </section>

        {/* Comparison */}
        <section id="compare" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">An Honest Comparison</h2>
            <p className="lp-section-sub">Every cell verified against official docs and public repos — including rows where the other side wins. That's what makes this honest.</p>
            <div className="lp-compare-table lp-reveal">
              <table>
                <thead>
                  <tr><th>Capability</th><th className="lp-highlight">Mercury</th><th>Claude Code</th><th>Codex CLI</th><th>Gemini CLI</th></tr>
                </thead>
                <tbody>
                  {[
                    ['Self-identity files', 'soul, persona, taste, heartbeat + guardrails', 'CLAUDE.md + auto memory', 'AGENTS.md', 'GEMINI.md'],
                    ['Model providers', 'Any provider — API key or OAuth, auto-fallback', 'Anthropic + third-party', 'OpenAI only', 'Gemini only'],
                    ['MCP external tools', '—', '✓', '✓', '✓'],
                    ['Parallel sub-agents', 'Persistent bots + parallel workers', 'Sub-agents + background agents', '—', '—'],
                    ['Scheduled autonomy', 'Daemon + cron + bot routines, 24/7 local', 'Cloud routines + desktop tasks', '—', '—'],
                    ['Messaging channels', 'Telegram bots with approval flows', 'Slack, Telegram, Discord, iMessage', '—', '—'],
                    ['Token budget', 'Daily budget + overrides + live stats', '—', '—', '—'],
                    ['Long-term memory', 'Second Brain (SQLite, auto-extract, conflict resolution)', 'Auto memory', 'AGENTS.md', 'GEMINI.md'],
                    ['GitHub companion', 'PRs, issues, co-authored commits', 'Actions + auto code review', '—', '—'],
                    ['Security sandbox', 'Permission modes + safe whitelist', 'Sandboxed execution + prompts', 'OS-level sandbox', 'Sandbox profiles'],
                    ['IDE surface', 'Built-in workspace (files, git, shortcuts)', 'VS Code, JetBrains, Desktop', 'VS Code, Cursor, Windsurf', 'IDE integrations'],
                    ['License', 'MIT', 'Source-available', 'Apache-2.0', 'Apache-2.0'],
                  ].map((row, i) => (
                    <tr key={i}>
                      <td>{row[0]}</td>
                      {row.slice(1).map((cell, j) => (
                        <td
                          key={j}
                          className={
                            cell === '—'
                              ? (j === 0 ? 'lp-highlight lp-no' : 'lp-no')
                              : cell.startsWith('✓')
                                ? (j === 0 ? 'lp-highlight lp-yes' : 'lp-yes')
                                : (j === 0 ? 'lp-highlight' : undefined)
                          }
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="lp-provider-note">
              Checked September 2026 against each product's official documentation and public repositories. Codex and Gemini CLI are licensed more openly than Mercury (Apache-2.0 vs MIT terms); Gemini CLI ships native MCP support we don't have yet. We keep those rows visible on purpose. Spotted a cell that's wrong? <a href="https://github.com/CosmicStack/mercury/issues" target="_blank" rel="noopener noreferrer">Open an issue</a>.
            </p>
          </div>
        </section>

        {/* Install */}
        <section id="install" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">Up and Running in 60 Seconds</h2>
            <div className="lp-install-steps">
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">1</div>
                <div>
                  <h4>Install</h4>
                  <div className="lp-terminal-inline"><code>npm i -g @cosmicstack/mercury-agent</code></div>
                </div>
              </div>
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">2</div>
                <div>
                  <h4>Setup</h4>
                  <div className="lp-terminal-inline"><code>mercury</code></div>
                  <p>Onboarding wizard: choose providers, validate keys, pair Telegram.</p>
                </div>
              </div>
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">3</div>
                <div>
                  <h4>Run</h4>
                  <div className="lp-terminal-inline"><code>mercury up</code></div>
                  <p>Starts as a daemon. Auto-restarts on crash. Runs 24/7.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section id="cta" className="lp-section lp-cta-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Deploy Your Agent</h2>
            <div className="lp-cta-terminal">
              <code>npm i -g @cosmicstack/mercury-agent && mercury</code>
            </div>
            <p className="lp-cta-sub">60 seconds to your own AI agent.</p>
            <div className="lp-cta-links">
              <Link to="/cloud">Mercury Cloud</Link>
              <Link to="/docs">Documentation</Link>
              <a href="https://github.com/cosmicstack-labs/mercury-agent" target="_blank" rel="noopener">GitHub</a>
              <a href="https://github.com/cosmicstack-labs/mercury-agent/issues" target="_blank" rel="noopener">Report an Issue</a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="lp-footer">
          <div className="lp-container lp-footer-inner">
            <div>
              <img src="/img/logo-full-dark.png" alt="Mercury" className="lp-footer-logo-img" />
              <span className="lp-footer-tagline">by Cosmic Stack</span>
            </div>
            <div className="lp-footer-links">
              <Link to="/cloud">Mercury Cloud</Link>
              <Link to="/docs">Docs</Link>
              <a href="https://github.com/cosmicstack-labs/mercury-agent">GitHub</a>
              <a href="https://github.com/cosmicstack-labs/mercury-agent/issues">Issues</a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}
