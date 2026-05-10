import React, { useEffect, useRef } from 'react';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import Killipi from '@site/src/components/Killipi';
import '@site/src/css/landing.css';

type TerminalLine = {
  type: 'prompt' | 'input' | 'tool' | 'output' | 'status' | 'agent' | 'stream' | 'autopilot' | 'completion';
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
  { type: 'output', text: '  Agent a1: researching pagination strategies' },
  { type: 'output', text: '  Agent a2: implementing cursor-based pagination' },
  { type: 'tool', text: '  🔄 a1: fetch_url, fetch_url, read_file' },
  { type: 'tool', text: '  🔄 a2: read_file, edit_file, create_file' },
  { type: 'completion', text: '  ✅ a1 completed (12.3s) — 3 strategies compared' },
  { type: 'completion', text: '  ✅ a2 completed (18.7s) — cursor pagination added to 4 endpoints' },
  { type: 'agent', text: 'Mercury: ' },
  { type: 'stream', text: 'Both agents are done. a1 found that cursor-based is optimal for our use case (confirmed by a2\'s implementation). Want me to review the changes?' },
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

export default function LandingPage(): React.ReactElement {
  const heroTermRef = useRef<HTMLDivElement>(null);
  const agentTermRef = useRef<HTMLDivElement>(null);
  const [ghStars, setGhStars] = React.useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = React.useState(false);

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
    const heroEl = heroTermRef.current;
    const agentEl = agentTermRef.current;

    const heroObs = heroEl
      ? new IntersectionObserver(
        entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              heroObs.unobserve(entry.target);
              typeTerminal(heroEl, heroLines, 22);
            }
          });
        },
        { threshold: 0.3 }
      )
      : null;

    const agentObs = agentEl
      ? new IntersectionObserver(
        entries => {
          entries.forEach(entry => {
            if (entry.isIntersecting) {
              agentObs.unobserve(entry.target);
              typeTerminal(agentEl, multiAgentLines, 20);
            }
          });
        },
        { threshold: 0.3 }
      )
      : null;

    if (heroEl && heroObs) heroObs.observe(heroEl);
    if (agentEl && agentObs) agentObs.observe(agentEl);

    return () => {
      if (heroObs) heroObs.disconnect();
      if (agentObs) agentObs.disconnect();
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
        <title>Mercury — AI Agent That Thinks, Acts, and Asks Permission</title>
        <meta name="description" content="An AI coding agent with real-time progress, multi-agent orchestration, intelligent loop detection, and hardened permissions. Runs 24/7 from CLI or Telegram." />
        <meta property="og:title" content="Mercury — AI Agent That Thinks, Acts, and Asks Permission" />
        <meta property="og:description" content="An AI coding agent with real-time progress, multi-agent orchestration, and hardened permissions. Runs 24/7 from CLI or Telegram." />
        <meta property="og:type" content="website" />
        <meta property="og:url" content="https://mercury.cosmicstack.org" />
        <meta property="og:image" content="https://mercury.cosmicstack.org/img/card.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="Mercury — AI Agent That Thinks, Acts, and Asks Permission" />
        <meta name="twitter:image" content="https://mercury.cosmicstack.org/img/card.png" />
      </Head>

      <div className="lp-page">
        {/* Navigation */}
        <nav className="lp-nav">
          <div className="lp-nav-inner">
            <Link to="/" className="lp-nav-logo">
              <span className="lp-nav-logo-icon">☿</span> Mercury
            </Link>
            <div className={`lp-nav-links ${mobileMenuOpen ? 'lp-nav-links-open' : ''}`}>
              <Link to="/#pillars" onClick={() => setMobileMenuOpen(false)}>Features</Link>
              <Link to="/#live-demo" onClick={() => setMobileMenuOpen(false)}>Demo</Link>
              <Link to="/#channels" onClick={() => setMobileMenuOpen(false)}>Channels</Link>
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

        {/* Hero */}
        <section className="lp-hero">
          <div className="lp-hero-mesh" />
          <div className="lp-hero-glow" />
          <div className="lp-container lp-hero-content">
            <Killipi />
            <h1 className="lp-hero-title">
              The AI agent that<br />
              <span className="lp-hero-highlight">thinks, acts, and asks.</span>
            </h1>
            <p className="lp-hero-sub">
              Multi-agent orchestration. Real-time progress. Intelligent loop detection.
              40+ tools. Permission guardrails. Runs 24/7 from your terminal or Telegram.
            </p>
            <div className="lp-hero-actions">
              <Link href="#live-demo" className="lp-btn lp-btn-primary">See It Work</Link>
              <Link to="/docs" className="lp-btn lp-btn-secondary">Get Started</Link>
            </div>
            <div className="lp-hero-install">
              <code>npm i -g @cosmicstack/mercury-agent && mercury</code>
            </div>
          </div>
        </section>

        {/* Three Pillars */}
        <section id="pillars" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Built Different</h2>
            <p className="lp-section-sub">Three principles that define Mercury.</p>
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

        {/* Live Demo */}
        <section id="live-demo" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">Watch Mercury Work</h2>
            <p className="lp-section-sub">A real multi-step coding task with tool calls, progress tracking, and completion stats.</p>
            <div className="lp-terminal-window lp-terminal-hero">
              <div className="lp-terminal-bar">
                <span className="lp-terminal-dot lp-dot-red" />
                <span className="lp-terminal-dot lp-dot-yellow" />
                <span className="lp-terminal-dot lp-dot-green" />
                <span className="lp-terminal-title">mercury</span>
              </div>
              <div className="lp-terminal-body" ref={heroTermRef} />
            </div>
          </div>
        </section>

        {/* How It Works — Task Flow */}
        <section id="task-flow" className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Real-Time Task Intelligence</h2>
            <p className="lp-section-sub">Mercury shows you exactly what's happening, when it's happening.</p>
            <div className="lp-flow-timeline lp-reveal">
              {[
                { step: '1', label: 'Message', desc: 'You send a task. Mercury begins working.' },
                { step: '2', label: 'Status Card', desc: 'A single message appears showing live progress. On Telegram, it pins to the top.' },
                { step: '3', label: 'Tool Steps', desc: 'Each tool call updates the card in place — read, edit, run, create. Last 5 steps visible.' },
                { step: '4', label: 'Autopilot', desc: 'If Mercury detects a loop, it analyzes diversity and success rate. Productive work continues; stuck patterns stop.' },
                { step: '5', label: 'Complete', desc: 'Status card deleted. AI response + completion banner with token stats and budget usage.' },
              ].map((s, i) => (
                <div key={i} className="lp-flow-step">
                  <div className="lp-flow-dot">{s.step}</div>
                  <div className="lp-flow-content">
                    <h4>{s.label}</h4>
                    <p>{s.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Channels — CLI + Telegram */}
        <section id="channels" className="lp-section lp-section-alt">
          <div className="lp-container">
            <h2 className="lp-section-title">Two Channels, One Agent</h2>
            <p className="lp-section-sub">Same capabilities. Different interfaces. Both real-time.</p>
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
                  <li>Keyboard shortcuts: Ctrl+B (background), Ctrl+T (view), Ctrl+P (plan)</li>
                  <li>Multi-line input, input history, streaming output</li>
                  <li>Interactive Spotify player with seek and volume</li>
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
            </div>
          </div>
        </section>

        {/* Multi-Agent */}
        <section id="agents" className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">Multi-Agent Orchestration</h2>
            <p className="lp-section-sub">Mercury spawns parallel agents. You keep chatting.</p>
            <div className="lp-terminal-window" style={{ maxWidth: 760, margin: '0 auto' }}>
              <div className="lp-terminal-bar">
                <span className="lp-terminal-dot lp-dot-red" />
                <span className="lp-terminal-dot lp-dot-yellow" />
                <span className="lp-terminal-dot lp-dot-green" />
                <span className="lp-terminal-title">mercury — multi-agent</span>
              </div>
              <div className="lp-terminal-body" ref={agentTermRef} />
            </div>
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
            <p className="lp-section-sub">Mercury remembers — automatically, privately, and with surgical precision.</p>
            <div className="lp-brain-grid">
              {[
                { title: 'Learns Automatically', desc: 'After each conversation, Mercury extracts facts — preferences, goals, projects, habits, decisions.' },
                { title: 'Recalls What Matters', desc: 'Only relevant memories injected — up to 5 facts within a 900-character budget per request.' },
                { title: 'Resolves Conflicts', desc: 'When Mercury detects a contradiction, the higher-confidence memory wins. No stale data.' },
                { title: '10 Memory Types', desc: 'Identity, preference, goal, project, habit, decision, constraint, relationship, episode, and reflection.' },
                { title: 'Auto-Consolidation', desc: 'Hourly synthesis of profile summaries and reflections from detected patterns.' },
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
                { name: 'ChatGPT Web', desc: 'Use your ChatGPT Plus/Pro subscription. OAuth login, no API key.', badge: 'NEW' },
                { name: 'GitHub Copilot', desc: 'Your Copilot subscription — access OpenAI, Anthropic, and Google models.', badge: 'NEW' },
                { name: 'DeepSeek', desc: 'Cost-effective with strong reasoning. Default provider.' },
                { name: 'OpenAI', desc: 'GPT-4o-mini, GPT-4o, o3. Industry standard.' },
                { name: 'Anthropic', desc: 'Claude Sonnet, Haiku, Opus. Nuanced reasoning.' },
                { name: 'Grok (xAI)', desc: "xAI's models via OpenAI-compatible endpoint." },
                { name: 'Ollama Cloud', desc: 'Remote Ollama models via API. No local setup.' },
                { name: 'Ollama Local', desc: 'On your machine. Zero cost, fully private.' },
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
            <h2 className="lp-section-title">Honest Comparison</h2>
            <p className="lp-section-sub">We built Mercury because nothing else did all of this.</p>
            <div className="lp-compare-table lp-reveal">
              <table>
                <thead>
                  <tr><th>Feature</th><th className="lp-highlight">Mercury</th><th>Open Interpreter</th><th>Claude Code</th></tr>
                </thead>
                <tbody>
                  {[
                    ['Multi-Agent Orchestration', 'Parallel workers + file locks', '—', '—'],
                    ['Loop Detection (Autopilot)', 'Diversity + success analysis', '—', '—'],
                    ['Real-Time Progress', 'Single edited status card + pin', '—', '—'],
                    ['Permission Modes', 'Ask Me / Allow All + safe whitelist', 'Confirmation prompts', 'Permission prompts'],
                    ['Telegram Integration', 'Inline keyboards, pinned progress, org access', '—', '—'],
                    ['Token Budget', 'Daily budget + override + color-coded stats', '—', '—'],
                    ['Spotify Integration', 'Native playback + DJ mode + 14 tools', '—', '—'],
                    ['Skill System', 'Install, invoke, schedule with elevation', '—', '—'],
                    ['Soul / Persona System', '4 markdown files', 'Custom instructions', 'CLAUDE.md'],
                    ['GitHub Companion', 'PRs, issues, co-authored commits', '—', '—'],
                    ['Provider Fallback', 'Auto with last-successful tracking', 'Manual config', 'Anthropic only'],
                    ['Second Brain', 'Auto-extract, 10 types, conflict resolution', '—', '—'],
                    ['Workspace IDE', 'File explorer, git panel, keyboard shortcuts', '—', '—'],
                    ['24/7 Headless', 'Daemon + system service + cron scheduling', '—', '—'],
                    ['Open Source', 'MIT', 'LGPL-2.1', 'Source-available'],
                  ].map((row, i) => (
                    <tr key={i}>
                      <td>{row[0]}</td>
                      <td className="lp-highlight">{row[1]}</td>
                      <td className={row[2] === '—' ? 'lp-no' : 'lp-partial'}>{row[2]}</td>
                      <td className={row[3] === '—' ? 'lp-no' : 'lp-partial'}>{row[3]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              <span className="lp-footer-logo">☿ Mercury</span>
              <span className="lp-footer-tagline">by Cosmic Stack</span>
            </div>
            <div className="lp-footer-links">
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
