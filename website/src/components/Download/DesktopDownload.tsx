import React, { useEffect, useState } from 'react';
import MacDmgLink from './MacDmgLink';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import { detect, UNKNOWN, type Detected } from './detect';
import { asset, sizeOf, DESKTOP, GITHUB_RELEASES, type AssetKey } from './release';

interface Choice { key: AssetKey; label: string }

/** The one button for this computer, and the other links worth offering beside it. */
function choicesFor(d: Detected): { primary: Choice | null; also: Choice[] } {
  const ok = (c: Choice) => asset(c.key) !== null;
  const pick = (list: Choice[]) => {
    const avail = list.filter(ok);
    return { primary: avail[0] ?? null, also: avail.slice(1) };
  };
  const silicon: Choice = { key: 'macos-arm64', label: 'for macOS (Apple Silicon)' };
  const intel: Choice = { key: 'macos-x64', label: 'for macOS (Intel)' };
  switch (d.os) {
    case 'macos':
      return pick(d.appleSilicon === false ? [intel, silicon] : [silicon, intel]);
    case 'windows':
      return pick([{ key: 'windows-x64-setup', label: 'for Windows' }, { key: 'windows-x64-msi', label: 'MSI package' }]);
    case 'linux':
      return pick([
        { key: 'linux-appimage', label: 'for Linux (AppImage)' },
        { key: 'linux-deb', label: '.deb' },
        { key: 'linux-rpm', label: '.rpm' },
      ]);
    default:
      return { primary: null, also: [] };
  }
}

export const AppleIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
    <path d="M16.37 12.46c-.02-2.1 1.72-3.12 1.8-3.17-.98-1.43-2.5-1.63-3.04-1.65-1.29-.13-2.52.76-3.18.76-.66 0-1.67-.74-2.75-.72-1.41.02-2.72.82-3.45 2.09-1.47 2.55-.38 6.33 1.06 8.4.7 1.01 1.53 2.15 2.62 2.11 1.05-.04 1.45-.68 2.72-.68 1.27 0 1.63.68 2.74.66 1.13-.02 1.85-1.03 2.54-2.05.8-1.17 1.13-2.31 1.15-2.37-.03-.01-2.2-.84-2.21-3.38zM14.3 6.3c.58-.7.97-1.68.86-2.65-.83.03-1.84.55-2.44 1.25-.53.62-1 1.62-.88 2.57.93.07 1.88-.47 2.46-1.17z" />
  </svg>
);
export const WindowsIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M3 5.5l7.5-1v7H3v-6zm0 13l7.5 1v-7H3v6zm8.5 1.1L21 21v-8.5h-9.5v7.1zm0-15.2v7.1H21V3l-9.5 1.4z" />
  </svg>
);
export const LinuxIcon = () => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true">
    <path d="M12 2c-2.2 0-3.6 1.8-3.6 4.4 0 1.5.4 2.6.2 3.6-.3 1.4-2.6 3.4-3.1 6-.3 1.5.3 2.5 1.2 2.9.9.4 1.4 1.1 2.3 1.6 1 .6 2.3.5 3 .5s2 .1 3-.5c.9-.5 1.4-1.2 2.3-1.6.9-.4 1.5-1.4 1.2-2.9-.5-2.6-2.8-4.6-3.1-6-.2-1 .2-2.1.2-3.6C15.6 3.8 14.2 2 12 2zm-1.4 4.2c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zm2.8 0c.4 0 .7.5.7 1.1s-.3 1.1-.7 1.1-.7-.5-.7-1.1.3-1.1.7-1.1zM12 9.4c.9 0 2 .6 2 1s-1.1 1.1-2 1.1-2-.7-2-1.1 1.1-1 2-1z" />
  </svg>
);

export function iconFor(key: AssetKey) {
  if (key.startsWith('macos')) return <AppleIcon />;
  if (key.startsWith('windows')) return <WindowsIcon />;
  return <LinuxIcon />;
}

/**
 * The landing page's main call to action: one big "Download Mercury Desktop
 * for <this computer>" button. Before the browser has been asked (and in the
 * static HTML) it's a neutral button to /download.
 */
/** `compact`: a small secondary button (on a Mac the Terminal install leads, the .dmg is the alternative). */
export default function DesktopDownload({ className, compact = false }: { className?: string; compact?: boolean }): React.ReactElement {
  const [detected, setDetected] = useState<Detected>(UNKNOWN);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    detect().then((d) => { if (live) { setDetected(d); setReady(true); } }).catch(() => setReady(true));
    return () => { live = false; };
  }, []);

  const { primary, also } = choicesFor(detected);

  if (ready && detected.os === 'mobile') {
    return (
      <div className={clsx('mx-dl', className)}>
        <p className="mx-dl__mobile">
          Mercury Desktop runs on macOS, Windows and Linux. Open this page on your computer to download it.
          From a phone, you can <Link to="/docs/desktop/remote-access">connect to a Mercury running elsewhere</Link> or
          browse the <a href={DESKTOP.notesUrl || GITHUB_RELEASES} target="_blank" rel="noopener noreferrer">release on GitHub</a>.
        </p>
      </div>
    );
  }

  const main = primary ? asset(primary.key) : null;
  const size = sizeOf(main);

  return (
    <div className={clsx('mx-dl', compact && 'mx-dl--compact', className)}>
      {main && primary ? (
        <MacDmgLink assetKey={primary.key} href={main.url} className={clsx('mx-btn', compact ? 'mx-dl__small' : 'mx-btn--primary mx-dl__main')}>
          {iconFor(primary.key)}
          <span>{compact ? 'Download the .dmg instead' : `Download Mercury Desktop ${primary.label}`}</span>
        </MacDmgLink>
      ) : (
        <Link to="/download" className="mx-btn mx-btn--primary mx-dl__main">
          <span>Download Mercury Desktop</span>
        </Link>
      )}
      <p className="mx-dl__meta">
        Version {DESKTOP.version}{size && ` · ${size}`}
        {also.map((c) => {
          const a = asset(c.key);
          return a ? <React.Fragment key={c.key}> · <MacDmgLink assetKey={c.key} href={a.url}>{c.label}</MacDmgLink></React.Fragment> : null;
        })}
        {' · '}<Link to="/download">Other downloads</Link>
        {detected.windowsArm && <> · runs on Windows on ARM through emulation</>}
      </p>
    </div>
  );
}
