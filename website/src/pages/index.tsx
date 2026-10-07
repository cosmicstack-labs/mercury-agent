import React, { useEffect, useState } from 'react';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import useBrokenLinks from '@docusaurus/useBrokenLinks';
import Layout from '@theme/Layout';
import Killipi from '@site/src/components/Killipi';
import Terminal from '@site/src/components/Home/Terminal';
import InstallCommand from '@site/src/components/Home/InstallCommand';
import {
  SITE_URL, GITHUB_URL, NPM_URL, SKILLS_URL, RELEASE, SEO, HERO_SCRIPT, CHAPTERS,
  PRODUCTS, CHANNELS, PROVIDERS, COMPARE, NOT_YET, FAQ,
} from '@site/src/components/Home/data';
import '@site/src/css/home.css';

/* ---- Structured data: what search engines read as "the product" ---- */
const JSON_LD = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE_URL}/#website`,
      url: SITE_URL,
      name: 'Mercury Agent',
      publisher: { '@id': `${SITE_URL}/#org` },
    },
    {
      '@type': 'Organization',
      '@id': `${SITE_URL}/#org`,
      name: 'Cosmic Stack',
      url: SITE_URL,
      logo: `${SITE_URL}/img/icon-512.svg`,
      sameAs: [GITHUB_URL, NPM_URL],
    },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE_URL}/#app`,
      name: 'Mercury Agent',
      description: SEO.description,
      url: SITE_URL,
      applicationCategory: 'DeveloperApplication',
      applicationSubCategory: 'AI agent',
      operatingSystem: 'macOS, Linux, Windows, Android (Termux)',
      softwareVersion: RELEASE.version,
      license: 'https://opensource.org/licenses/MIT',
      downloadUrl: `${GITHUB_URL}/releases/latest`,
      installUrl: `${SITE_URL}/docs`,
      image: `${SITE_URL}/img/og/home.png`,
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': `${SITE_URL}/#org` },
    },
    {
      '@type': 'FAQPage',
      mainEntity: FAQ.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    },
  ],
};

function useGithubStars(): string | null {
  const [stars, setStars] = useState<string | null>(null);
  useEffect(() => {
    fetch('https://api.github.com/repos/cosmicstack-labs/mercury-agent')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        const n = d?.stargazers_count;
        if (typeof n === 'number') setStars(n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n));
      })
      .catch(() => {});
  }, []);
  return stars;
}

function Hero({ stars }: { stars: string | null }) {
  return (
    <header className="mx-hero">
      <div className="mx-wrap mx-hero__inner">
        <div className="mx-hero__glyph"><Killipi /></div>
        <Link to={RELEASE.notes} className="mx-pill">
          <span className="mx-pill__dot" aria-hidden="true" />
          New in {RELEASE.version}: {RELEASE.name}
          <span aria-hidden="true">→</span>
        </Link>
        <h1 className="mx-hero__title">
          The AI agent you can <em>leave running.</em>
        </h1>
        <p className="mx-hero__sub">
          Mercury is an open-source agent that lives on your machine, remembers what matters,
          and asks before it acts. Bring any model. Talk to it from your terminal, browser,
          Telegram, Discord, Slack, or Signal.
        </p>
        <InstallCommand className="mx-hero__install" />
        <div className="mx-hero__links">
          <Link to="/docs" className="mx-btn mx-btn--primary">Read the docs</Link>
          <a href={GITHUB_URL} className="mx-btn" target="_blank" rel="noopener noreferrer">
            <GithubIcon /> Star on GitHub{stars && <span className="mx-btn__count">{stars}</span>}
          </a>
        </div>
      </div>
      <div className="mx-wrap mx-hero__demo">
        <Terminal lines={HERO_SCRIPT} title="mercury — ~/projects/acme" syncGlyph />
      </div>
    </header>
  );
}

function TrustStrip() {
  const items = [
    { big: 'MIT', small: 'open source, self-hosted' },
    { big: 'Local', small: 'memory in SQLite on your disk' },
    { big: '0', small: 'telemetry in the agent' },
    { big: '~50', small: 'built-in tools, permission-gated' },
    { big: '10+', small: 'model providers, auto-fallback' },
  ];
  return (
    <section className="mx-strip" aria-label="At a glance">
      <div className="mx-wrap mx-strip__grid">
        {items.map((i) => (
          <div key={i.small} className="mx-strip__item">
            <span className="mx-strip__big">{i.big}</span>
            <span className="mx-strip__small">{i.small}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Chapters() {
  return (
    <section className="mx-section" id="trust" aria-labelledby="trust-title">
      <div className="mx-wrap">
        <div className="mx-head">
          <p className="mx-kicker">Built on trust</p>
          <h2 id="trust-title" className="mx-h2">An agent is only useful <em>if you can rely on it.</em></h2>
          <p className="mx-lead">
            Most agents are built to impress in a demo. Mercury is built for the day after,
            when it is running on its own with access to your files, your accounts, and your time.
          </p>
        </div>
        <div className="mx-chapters">
          {CHAPTERS.map((c, idx) => (
            <article key={c.id} id={c.id} className={`mx-chapter ${idx % 2 ? 'mx-chapter--flip' : ''}`}>
              <div className="mx-chapter__copy">
                <p className="mx-kicker">{c.kicker}</p>
                <h3 className="mx-h3">{c.title}</h3>
                <p>{c.body}</p>
                <ul className="mx-list">
                  {c.points.map((p) => <li key={p}>{p}</li>)}
                </ul>
                <Link to={c.link.to} className="mx-arrow">{c.link.label} →</Link>
              </div>
              <Terminal lines={c.script} title={c.scriptTitle} className="mx-chapter__term" />
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function Products() {
  return (
    <section className="mx-section mx-section--alt" id="products" aria-labelledby="products-title">
      <div className="mx-wrap">
        <div className="mx-head">
          <p className="mx-kicker">One agent, three ways to scale it</p>
          <h2 id="products-title" className="mx-h2">From one conversation <em>to a whole crew.</em></h2>
        </div>
        <div className="mx-products">
          {PRODUCTS.map((p) => (
            <Link key={p.name} to={p.to} className="mx-product">
              <span className="mx-product__tag">{p.tag}</span>
              <h3 className="mx-product__name">{p.name}</h3>
              <p className="mx-product__title">{p.title}</p>
              <p className="mx-product__body">{p.body}</p>
              <span className="mx-arrow">Learn more →</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function Everywhere() {
  return (
    <section className="mx-section" id="channels" aria-labelledby="channels-title">
      <div className="mx-wrap mx-split">
        <div className="mx-head mx-head--left">
          <p className="mx-kicker">Everywhere you are</p>
          <h2 id="channels-title" className="mx-h2">Six channels. <em>One memory.</em></h2>
          <p className="mx-lead">
            Every channel shares one tool registry, one permission system, and one Second Brain.
            Start a task in the terminal and check on it from Telegram.
          </p>
          <p className="mx-lead mx-lead--small">
            Extend it with <a href={SKILLS_URL} target="_blank" rel="noopener noreferrer">126+ community skills</a>,
            based on the open Agent Skills spec. Install one with a single command after reading its source.
          </p>
        </div>
        <div>
          <ul className="mx-channels">
            {CHANNELS.map((c) => (
              <li key={c.name}>
                <strong>{c.name}</strong>
                <span>{c.note}</span>
              </li>
            ))}
          </ul>
          <p className="mx-providers-label">Works with</p>
          <ul className="mx-providers">
            {PROVIDERS.map((p) => <li key={p}>{p}</li>)}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Honest() {
  return (
    <section className="mx-section mx-section--alt" id="compare" aria-labelledby="compare-title">
      <div className="mx-wrap">
        <div className="mx-head">
          <p className="mx-kicker">Honest by design</p>
          <h2 id="compare-title" className="mx-h2">How Mercury compares, <em>including where it doesn’t win.</em></h2>
          <p className="mx-lead">
            Checked in September 2026 against each product’s official docs and public repos.
            Rows where Mercury loses are left in on purpose.
          </p>
        </div>
        <div className="mx-table-wrap">
          <table className="mx-table">
            <thead>
              <tr>{COMPARE.head.map((h, i) => <th key={i} scope="col">{h}</th>)}</tr>
            </thead>
            <tbody>
              {COMPARE.rows.map((r) => (
                <tr key={r[0]}>
                  <th scope="row">{r[0]}</th>
                  {r.slice(1).map((cell, j) => (
                    <td key={j} className={cell === '—' ? 'is-no' : cell === '✓' ? 'is-yes' : undefined}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mx-notyet">
          {NOT_YET.map((n) => (
            <div key={n.title} className="mx-notyet__item">
              <h3>{n.title}</h3>
              <p>{n.body}</p>
            </div>
          ))}
        </div>
        <p className="mx-fine">
          Spotted a cell that’s wrong? <a href={`${GITHUB_URL}/issues`} target="_blank" rel="noopener noreferrer">Open an issue</a> and we’ll fix it.
        </p>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section className="mx-section" id="faq" aria-labelledby="faq-title">
      <div className="mx-wrap mx-split">
        <div className="mx-head mx-head--left">
          <p className="mx-kicker">Questions</p>
          <h2 id="faq-title" className="mx-h2">Before you <em>hand it the keys.</em></h2>
        </div>
        <div className="mx-faq">
          {FAQ.map((f) => (
            <details key={f.q}>
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="mx-final" id="install" aria-labelledby="install-title">
      <div className="mx-wrap mx-final__inner">
        <h2 id="install-title" className="mx-h2">Up and running <em>in about a minute.</em></h2>
        <p className="mx-lead">Install, answer the setup wizard, then run <code>mercury up</code> to keep it running for good.</p>
        <InstallCommand />
        <div className="mx-final__links">
          <Link to="/docs">Getting started</Link>
          <Link to="/docs/getting-started/platforms/macos">Platform guides</Link>
          <Link to={RELEASE.notes}>Release notes</Link>
          <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer">Source on GitHub</a>
        </div>
      </div>
    </section>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Section ids other pages link to (/#install, /#compare…), registered for the anchor checker. */
const ANCHORS = ['trust', ...CHAPTERS.map((c) => c.id), 'products', 'channels', 'compare', 'faq', 'install'];

export default function Home(): React.ReactElement {
  const stars = useGithubStars();
  const brokenLinks = useBrokenLinks();
  ANCHORS.forEach((id) => brokenLinks.collectAnchor(id));
  return (
    <Layout description={SEO.description} wrapperClassName="mx-home">
      <Head>
        <title>{SEO.title}</title>
        <meta property="og:title" content={SEO.title} />
        <meta name="twitter:title" content={SEO.title} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={`${SITE_URL}/`} />
        <meta property="og:image" content={`${SITE_URL}/img/og/home.png`} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content="Mercury Agent: the AI agent you can leave running." />
        <meta name="twitter:image" content={`${SITE_URL}/img/og/home.png`} />
        <link rel="canonical" href={`${SITE_URL}/`} />
        <script type="application/ld+json">{JSON.stringify(JSON_LD)}</script>
      </Head>
      <main>
        <Hero stars={stars} />
        <TrustStrip />
        <Chapters />
        <Products />
        <Everywhere />
        <Honest />
        <Faq />
        <FinalCta />
      </main>
    </Layout>
  );
}
