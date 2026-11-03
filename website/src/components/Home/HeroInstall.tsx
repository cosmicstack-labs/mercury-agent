import React, { useEffect, useState } from 'react';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import DesktopDownload from '@site/src/components/Download/DesktopDownload';
import PlatformGrid from '@site/src/components/Download/PlatformGrid';
import MacInstall from '@site/src/components/Download/MacInstall';
import { detect } from '@site/src/components/Download/detect';
import { DESKTOP, releaseDate } from '@site/src/components/Download/release';
import InstallCommand from './InstallCommand';

type Tab = 'desktop' | 'server';

/**
 * The hero's install card: Mercury Desktop first (the button for this
 * computer, then every platform), or Mercury on a server (the one-line
 * installers and npm). Same release, same version.
 */
export default function HeroInstall({ className }: { className?: string }): React.ReactElement {
  const [tab, setTab] = useState<Tab>('desktop');
  const [mac, setMac] = useState(false);
  useEffect(() => { detect().then((d) => setMac(d.os === 'macos')).catch(() => {}); }, []);
  return (
    <section className={clsx('mx-hero-install', className)} aria-label="Install Mercury">
      <div className="mx-hero-install__head">
        <div className="mx-hero-install__tabs" role="tablist" aria-label="Where to install">
          <button type="button" role="tab" aria-selected={tab === 'desktop'} className={clsx('mx-hero-install__tab', tab === 'desktop' && 'is-active')} onClick={() => setTab('desktop')}>
            Desktop app
          </button>
          <button type="button" role="tab" aria-selected={tab === 'server'} className={clsx('mx-hero-install__tab', tab === 'server' && 'is-active')} onClick={() => setTab('server')}>
            Server / CLI
          </button>
        </div>
        <p className="mx-hero-install__version">
          <span className="mx-hero-install__badge">v{DESKTOP.version}</span>
          {releaseDate()} · <Link to={`/docs/releases/${DESKTOP.version}`}>What's new</Link>
        </p>
      </div>

      {tab === 'desktop' ? (
        <div className="mx-hero-install__body" role="tabpanel">
          {mac && <MacInstall />}
          {mac && <p className="mx-hero-install__or">Or download it</p>}
          <DesktopDownload compact={mac} />
          <PlatformGrid />
          <p className="mx-hero-install__note">
            Free and open source. Not code-signed yet: {mac ? 'a downloaded .dmg' : 'your computer'} asks once before the first launch (<Link to="/download#first-open">how</Link>).
            Updates arrive in the app.
          </p>
        </div>
      ) : (
        <div className="mx-hero-install__body" role="tabpanel">
          <p className="mx-hero-install__lead">Run Mercury on a server, a Raspberry Pi or in your terminal, then reach it from Mercury Desktop, Telegram, WhatsApp or the browser.</p>
          <InstallCommand />
          <p className="mx-hero-install__note">
            Already installed? <code>mercury upgrade</code> updates it and rolls back on its own if anything goes wrong. <Link to="/docs/releases">All releases</Link>
          </p>
        </div>
      )}
    </section>
  );
}
