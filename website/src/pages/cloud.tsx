import React, { useEffect, useRef, useState } from 'react';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import '@site/src/css/landing.css';

type CloudTerminalLine = {
  type: 'prompt' | 'input' | 'tool' | 'output' | 'status' | 'agent' | 'stream' | 'completion';
  text: string;
};

const pairingLines: CloudTerminalLine[] = [
  { type: 'prompt', text: '$ ' },
  { type: 'input', text: 'mercury cloud connect' },
  { type: 'status', text: '  Starting terminal pairing flow...' },
  { type: 'output', text: '  Open this URL in your browser to register and connect:' },
  { type: 'output', text: '  https://cloud.mercuryagent.sh/pair?code=MC-X4F2' },
  { type: 'status', text: '  Waiting for approval (timeout in 5 minutes)...' },
  { type: 'tool', text: '  ✓ Pairing approved' },
  { type: 'tool', text: '  Available models:' },
  { type: 'output', text: '    1. Mercury Flash (mercury-flash)' },
  { type: 'output', text: '    2. Mercury Pro (mercury-pro)' },
  { type: 'tool', text: '  Choose a model [1-2, Enter for 1]: 1' },
  { type: 'completion', text: '  ✓ Mercury Cloud connected!' },
  { type: 'output', text: '    Agent ID: ag_8f3a2c' },
  { type: 'output', text: '    Tier: free' },
  { type: 'output', text: '    Model: mercury-flash' },
  { type: 'completion', text: '  ✓ Mercury daemon started in the background.' },
];

function typeTerminal(container: HTMLDivElement, lines: CloudTerminalLine[], speed: number) {
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

    if (line.type === 'tool' || line.type === 'status' || line.type === 'output' || line.type === 'completion') {
      const span = document.createElement('span');
      span.className = line.type === 'tool' ? 'lp-tool' : line.type === 'status' ? 'lp-status' : line.type === 'completion' ? 'lp-completion' : 'lp-output';
      span.textContent = line.text;
      container.appendChild(span);
      container.appendChild(document.createElement('br'));
      idx++;
      setTimeout(nextLine, speed * 2);
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

export default function CloudPage(): React.ReactElement {
  const termRef = useRef<HTMLDivElement>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useEffect(() => {
    const el = termRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            obs.unobserve(entry.target);
            typeTerminal(el, pairingLines, 22);
          }
        });
      },
      { threshold: 0.3 },
    );
    obs.observe(el);
    return () => obs.disconnect();
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
      { threshold: 0.15 },
    );
    reveals.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <Head>
        <title>Mercury Cloud — Plug-and-play cloud backend for Mercury Agent</title>
        <meta name="description" content="Mercury Cloud is a hosted backend that turns a local Mercury install into a remotely managed, always-on agent. Terminal pairing, auto-rotating JWTs, Cloud WebSocket, shared memory pool, and remote dashboard." />
        <meta property="og:title" content="Mercury Cloud — Plug-and-play cloud backend" />
        <meta property="og:description" content="Pair from the terminal. Stay online forever. No port forwarding, no reverse proxy, no certificates." />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Mercury Agent — Soul-driven" />
        <meta property="og:url" content="https://mercuryagent.sh/cloud" />
        <meta property="og:image" content="https://mercuryagent.sh/img/og/home.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:site" content="@mercuryagent" />
        <meta name="twitter:title" content="Mercury Cloud — Plug-and-play cloud backend" />
        <meta name="twitter:description" content="Terminal pairing, auto-rotating JWTs, Cloud WebSocket, shared memory pool, and remote dashboard." />
        <meta name="twitter:image" content="https://mercuryagent.sh/img/og/home.png" />
        <link rel="canonical" href="https://mercuryagent.sh/cloud" />
      </Head>

      <div className="lp-page">
        {/* Navigation */}
        <nav className="lp-nav">
          <div className="lp-nav-inner">
            <Link to="/" className="lp-nav-logo">
              <img src="/img/logo-light.png" alt="Mercury Agent" className="lp-nav-logo-img" />
              Mercury Agent
            </Link>
            <div className={`lp-nav-links ${mobileMenuOpen ? 'lp-nav-links-open' : ''}`}>
              <Link to="/cloud">Mercury Cloud</Link>
              <Link to="/#pillars" onClick={() => setMobileMenuOpen(false)}>Features</Link>
              <Link to="/#live-demo" onClick={() => setMobileMenuOpen(false)}>Demo</Link>
              <Link to="/#channels" onClick={() => setMobileMenuOpen(false)}>Channels</Link>
              <Link to="/#compare" onClick={() => setMobileMenuOpen(false)}>Compare</Link>
              <Link to="/docs" onClick={() => setMobileMenuOpen(false)}>Docs</Link>
            </div>
            <div className="lp-nav-right">
              <a href="https://github.com/cosmicstack-labs/mercury-agent" className="lp-github-btn" target="_blank" rel="noopener">
                <svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" /></svg>
              </a>
              <button className="lp-nav-toggle" onClick={() => setMobileMenuOpen(!mobileMenuOpen)} aria-label="Menu">☰</button>
            </div>
          </div>
        </nav>

        {/* Hero */}
        <section className="lp-hero" style={{ paddingTop: 140, paddingBottom: 60 }}>
          <div className="lp-hero-mesh" />
          <div className="lp-hero-glow" />
          <div className="lp-container lp-hero-content">
            <div className="lp-hero-eyebrow">
              <span className="lp-hero-eyebrow-mark"><img src="/img/logo-light.png" alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: '50%' }} /></span>
              <span className="lp-hero-eyebrow-text">Mercury Cloud · v1.2.0</span>
              <span className="lp-hero-eyebrow-badge">Cloudy Mercury</span>
            </div>
            <h1 className="lp-hero-title">
              Pair from the terminal.<br />
              <span className="lp-hero-highlight">Stay online forever.</span>
            </h1>
            <p className="lp-hero-sub">
              Mercury Cloud is a hosted backend that turns your local agent into a remotely managed,
              always-on assistant. No port forwarding. No reverse proxy. No certificates. Just one command.
            </p>
            <div className="lp-hero-actions">
              <Link to="/docs/cloud/mercury-cloud" className="lp-btn lp-btn-primary">Get Started →</Link>
              <Link to="/docs/releases/1.2.0" className="lp-btn lp-btn-secondary">Release notes</Link>
            </div>
          </div>
        </section>

        {/* Pairing Demo */}
        <section className="lp-section lp-section-dark">
          <div className="lp-container">
            <h2 className="lp-section-title">One Command to Pair</h2>
            <p className="lp-section-sub">No API keys to manage. No firewalls to configure. Just run one command.</p>
            <div className="lp-terminal-window lp-terminal-hero" style={{ maxWidth: 680, margin: '0 auto' }}>
              <div className="lp-terminal-bar">
                <span className="lp-terminal-dot lp-dot-red" />
                <span className="lp-terminal-dot lp-dot-yellow" />
                <span className="lp-terminal-dot lp-dot-green" />
                <span className="lp-terminal-title">mercury cloud connect</span>
              </div>
              <div className="lp-terminal-body" ref={termRef} />
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="lp-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Everything Cloud</h2>
            <p className="lp-section-sub">What you get when you connect.</p>
            <div className="lp-channels-grid lp-reveal">
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">⚡</span>
                  <h3>Plug-and-play setup</h3>
                </div>
                <ul>
                  <li>One command pairs your agent: <code>mercury cloud connect</code></li>
                  <li>Browser-based pairing URL — no API keys to copy</li>
                  <li>No port forwarding, reverse proxy, or DNS needed</li>
                  <li>Works behind NAT and firewalls out of the box</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🔒</span>
                  <h3>Self-healing auth</h3>
                </div>
                <ul>
                  <li>JWT auto-rotated before expiry via single-use refresh token</li>
                  <li>Long-lived agent API key for headless self-recovery</li>
                  <li>Never needs browser re-pairing — stays online indefinitely</li>
                  <li>Shared token store keeps WS client and provider in sync</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🧠</span>
                  <h3>Collaborative knowledge</h3>
                </div>
                <ul>
                  <li>Shared memory pool across all your agents</li>
                  <li>Search cross-agent context after local Second Brain retrieval</li>
                  <li>5-minute SQLite cache per query to cut network cost</li>
                  <li>Fall-open design — cloud misses never block the chat turn</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🎛️</span>
                  <h3>Remote dashboard</h3>
                </div>
                <ul>
                  <li>Manage agents from <a href="https://cloud.mercuryagent.sh" target="_blank" rel="noopener">cloud.mercuryagent.sh</a></li>
                  <li>Send messages, install skills, view memory remotely</li>
                  <li>Monitor agent status and WebSocket health</li>
                  <li>Conversation sync across devices</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">📡</span>
                  <h3>Cloud WebSocket</h3>
                </div>
                <ul>
                  <li>Persistent WSS connection with 30-second heartbeats</li>
                  <li>Exponential backoff reconnect (up to 50 attempts)</li>
                  <li>Pre-connect token rotation — never handshakes with expired JWT</li>
                  <li>Stays alive in background daemon after you exit the terminal</li>
                </ul>
              </div>
              <div className="lp-channel-card">
                <div className="lp-channel-header">
                  <span className="lp-channel-icon">🚀</span>
                  <h3>Fast & accurate</h3>
                </div>
                <ul>
                  <li>Mercury Flash for instant responses</li>
                  <li>Mercury Pro for complex reasoning tasks</li>
                  <li>Model selection at pairing time — switch later anytime</li>
                  <li>OpenAI-compatible API — proven and reliable</li>
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* Agent Controls */}
        <section className="lp-section lp-section-alt">
          <div className="lp-container">
            <h2 className="lp-section-title">Agent Controls</h2>
            <p className="lp-section-sub">Full control from the CLI and the cloud dashboard.</p>
            <div className="lp-install-steps" style={{ maxWidth: 640 }}>
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">1</div>
                <div>
                  <h4>Connect</h4>
                  <div className="lp-terminal-inline"><code>mercury cloud connect</code></div>
                  <p>Pair with Mercury Cloud via browser. Choose your model.</p>
                </div>
              </div>
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">2</div>
                <div>
                  <h4>Manage remotely</h4>
                  <p>Open <a href="https://cloud.mercuryagent.sh" target="_blank" rel="noopener">cloud.mercuryagent.sh</a> to send messages, install skills, view memory, and monitor status.</p>
                </div>
              </div>
              <div className="lp-install-step lp-reveal">
                <div className="lp-install-num">3</div>
                <div>
                  <h4>Disconnect anytime</h4>
                  <div className="lp-terminal-inline"><code>mercury cloud disconnect</code></div>
                  <p>Clears all Cloud credentials and switches back to your offline provider.</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA */}
        <section id="cta" className="lp-section lp-section-dark lp-cta-section">
          <div className="lp-container">
            <h2 className="lp-section-title">Connect Your Agent</h2>
            <div className="lp-cta-terminal">
              <code>mercury cloud connect</code>
            </div>
            <p className="lp-cta-sub">One command. No servers. No ports.</p>
            <div className="lp-cta-links">
              <Link to="/docs/cloud/mercury-cloud">Documentation</Link>
              <Link to="/docs/releases/1.2.0">Release notes</Link>
              <a href="https://github.com/cosmicstack-labs/mercury-agent" target="_blank" rel="noopener">GitHub</a>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="lp-footer">
          <div className="lp-container lp-footer-inner">
            <div>
              <img src="/img/logo-full-light.png" alt="Mercury" className="lp-footer-logo-img" />
              <span className="lp-footer-tagline">by Cosmic Stack</span>
            </div>
            <div className="lp-footer-links">
              <Link to="/cloud">Mercury Cloud</Link>
              <Link to="/docs">Docs</Link>
              <a href="https://github.com/cosmicstack-labs/mercury-agent">GitHub</a>
            </div>
          </div>
        </footer>
      </div>
    </>
  );
}