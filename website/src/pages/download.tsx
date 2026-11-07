import Heading from '@theme/Heading';
import MacDmgLink from '@site/src/components/Download/MacDmgLink';
import React, { useEffect, useState } from 'react';
import Link from '@docusaurus/Link';
import Head from '@docusaurus/Head';
import Layout from '@theme/Layout';
import clsx from 'clsx';
import InstallCommand from '@site/src/components/Home/InstallCommand';
import MacInstall from '@site/src/components/Download/MacInstall';
import { SITE_URL } from '@site/src/components/Home/data';
import { detect, type DetectedOs } from '@site/src/components/Download/detect';
import { asset, sizeOf, DESKTOP, GITHUB_RELEASES, LABEL, releaseDate, type AssetKey } from '@site/src/components/Download/release';
import '@site/src/css/home.css';

const TITLE = 'Download Mercury Desktop for macOS, Windows and Linux';
const DESCRIPTION =
  'Download Mercury Desktop, the app for Mercury Agent, for macOS (Apple Silicon and Intel), Windows and Linux. Or install the Mercury server from the command line.';

const GROUPS: { os: Exclude<DetectedOs, 'mobile' | 'unknown'>; title: string; keys: AssetKey[] }[] = [
  { os: 'macos', title: 'macOS', keys: ['macos-arm64', 'macos-x64'] },
  { os: 'windows', title: 'Windows', keys: ['windows-x64-setup', 'windows-x64-msi'] },
  { os: 'linux', title: 'Linux', keys: ['linux-appimage', 'linux-deb', 'linux-rpm'] },
];

function Platform({ group, mine }: { group: (typeof GROUPS)[number]; mine: boolean }) {
  const items = group.keys.map((k) => ({ key: k, a: asset(k) })).filter((x) => x.a);
  return (
    <section className={clsx('mx-dlp__os', mine && 'is-mine')} aria-labelledby={`dl-${group.os}`}>
      <h2 id={`dl-${group.os}`} className="mx-dlp__os-title">
        {group.title}
        {mine && <span className="mx-dlp__mine">This computer</span>}
      </h2>
      {group.os === 'macos' && items.length > 0 && <MacInstall className="mx-dlp__mac" />}
      {group.os === 'macos' && items.length > 0 && <p className="mx-dlp__or">Or download the app:</p>}
      {items.length === 0 ? (
        <p className="mx-dlp__none">
          Not in this release yet. See <a href={GITHUB_RELEASES} target="_blank" rel="noopener noreferrer">all releases on GitHub</a>.
        </p>
      ) : (
        <ul className="mx-dlp__list">
          {items.map(({ key, a }) => (
            <li key={key}>
              <MacDmgLink assetKey={key} href={a!.url} className="mx-dlp__file">
                <span className="mx-dlp__what">{LABEL[key].what}</span>
                <span className="mx-dlp__detail">{LABEL[key].detail}{sizeOf(a) && ` · ${sizeOf(a)}`}</span>
              </MacDmgLink>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function Download(): React.ReactElement {
  const [mine, setMine] = useState<DetectedOs>('unknown');
  useEffect(() => { detect().then((d) => setMine(d.os)).catch(() => {}); }, []);

  return (
    <Layout description={DESCRIPTION} wrapperClassName="mx-home">
      <Head>
        <title>{TITLE}</title>
        <meta property="og:title" content={TITLE} />
        <meta property="og:url" content={`${SITE_URL}/download`} />
        <link rel="canonical" href={`${SITE_URL}/download`} />
      </Head>
      <main className="mx-section mx-dlp">
        <div className="mx-wrap">
          <div className="mx-head mx-head--left">
            <p className="mx-kicker">Download</p>
            <h1 className="mx-h2">Mercury Desktop <em>{DESKTOP.version}</em></h1>
            <p className="mx-lead">
              Released {releaseDate()} · <a href={DESKTOP.notesUrl} target="_blank" rel="noopener noreferrer">Release notes</a> ·{' '}
              <Link to="/docs/desktop/mercury-desktop">How to set it up</Link>
            </p>
            <p className="mx-lead mx-lead--small">
              The app installs Mercury on your computer for you, or connects to a Mercury you already run elsewhere. It updates itself.
            </p>
          </div>

          {mine === 'mobile' && (
            <p className="mx-dlp__notice">
              Mercury Desktop runs on computers. Open this page on your Mac, Windows or Linux computer to download it.
            </p>
          )}

          <div className="mx-dlp__grid">
            {GROUPS.map((g) => <Platform key={g.os} group={g} mine={mine === g.os} />)}
          </div>

          <section className="mx-dlp__first" aria-labelledby="first-open">
            <Heading as="h2" id="first-open" className="mx-h3">Opening it the first time</Heading>
            <p>
              This release isn't code-signed yet, so your computer asks before it opens the app once. Signing is coming in a
              later release. Every update after that is checked against Mercury's update signature before it installs.
            </p>
            <div className="mx-dlp__steps">
              <div>
                <h3>macOS</h3>
                <p>Installed with the Terminal command above? Nothing to do: it opens straight away. With the <code>.dmg</code>:</p>
                <ol>
                  <li>Open the <code>.dmg</code> and drag Mercury to Applications.</li>
                  <li>Open Mercury. macOS says it can't verify the developer ("Apple could not verify…"). Click <strong>Done</strong>.</li>
                  <li>Open <strong>System Settings → Privacy &amp; Security</strong>, scroll to Security and click <strong>Open Anyway</strong> next to Mercury, then confirm.</li>
                </ol>
                <p className="mx-dlp__alt">On older macOS versions you can also right-click Mercury in Applications and choose <strong>Open</strong>.</p>
                <p className="mx-dlp__alt">If macOS says Mercury "is damaged", run <code>xattr -dr com.apple.quarantine /Applications/Mercury.app</code> in Terminal, then open it again.</p>
                <p className="mx-dlp__alt">Something else? The <Link to="/docs/desktop/macos">macOS guide</Link> covers every message macOS shows.</p>
              </div>
              <div>
                <h3>Windows</h3>
                <ol>
                  <li>Run the installer.</li>
                  <li>If Microsoft Defender SmartScreen says "Windows protected your PC", click <strong>More info</strong>, then <strong>Run anyway</strong>.</li>
                </ol>
                <p className="mx-dlp__alt">The <code>.msi</code> is for installs managed by an administrator.</p>
              </div>
              <div>
                <h3>Linux</h3>
                <ol>
                  <li>AppImage: <code>chmod +x Mercury_*.AppImage</code>, then run it.</li>
                  <li>Debian / Ubuntu: <code>sudo apt install ./Mercury_*.deb</code></li>
                  <li>Fedora / openSUSE: <code>sudo dnf install ./Mercury-*.rpm</code></li>
                </ol>
              </div>
            </div>
          </section>

          <section className="mx-dlp__server" aria-labelledby="server-cli">
            <h2 id="server-cli" className="mx-h3">Run Mercury on a server</h2>
            <p>
              On a server, a Raspberry Pi or any machine without a screen, install the Mercury runtime from the command line.
              Mercury Desktop can then connect to it. See <Link to="/docs/desktop/remote-access">remote access and security</Link>.
            </p>
            <InstallCommand />
            <p className="mx-fine">
              All builds, checksums and older versions are on <a href={GITHUB_RELEASES} target="_blank" rel="noopener noreferrer">GitHub Releases</a>.
            </p>
          </section>
        </div>
      </main>
    </Layout>
  );
}
