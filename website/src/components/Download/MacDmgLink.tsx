import React, { useEffect, useRef, useState } from 'react';
import { MAC_INSTALL } from './MacInstall';
import './MacDmgLink.css';

/** What clears macOS's "downloaded from the internet" mark from Mercury, and nothing else. */
export const CLEAR_QUARANTINE = 'xattr -dr com.apple.quarantine /Applications/Mercury.app';

function CopyLine({ cmd, label }: { cmd: string; label: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the command is selectable text */
    }
  };
  return (
    <div className="mx-dmg__cmd">
      <code>{cmd}</code>
      <button type="button" onClick={copy} aria-label={label}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/**
 * A macOS .dmg link. Mercury Desktop isn't signed with an Apple Developer ID
 * yet, so before the download starts the visitor reads what macOS will do and
 * the one command that lets Mercury open, with why it's safe; or takes the
 * one-line installer, which needs none of it. Any other platform's link is a
 * plain link.
 */
export default function MacDmgLink({
  assetKey,
  href,
  className,
  children,
}: {
  assetKey: string;
  href: string;
  className?: string;
  children: React.ReactNode;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const mac = assetKey.startsWith('macos');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open]);

  if (!mac) return <a href={href} className={className} data-asset={assetKey}>{children}</a>;

  const chip = assetKey === 'macos-x64' ? 'Intel' : 'Apple Silicon';
  const dialog = open ? (
    <div className="mx-dmg" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
      <div className="mx-dmg__panel" role="dialog" aria-modal="true" aria-labelledby="mx-dmg-title" tabIndex={-1} ref={dialogRef}>
        <button type="button" className="mx-dmg__close" onClick={() => setOpen(false)} aria-label="Close">×</button>
        <h2 id="mx-dmg-title">One step before Mercury opens on your Mac</h2>
        <p className="mx-dmg__lead">
          Mercury Desktop isn't signed with an Apple Developer certificate yet, so macOS stops apps like it from the internet
          the first time. After you drag Mercury into Applications, paste this into <strong>Terminal</strong> once:
        </p>
        <CopyLine cmd={CLEAR_QUARANTINE} label="Copy the command" />

        <div className="mx-dmg__grid">
          <div>
            <h3>What it does</h3>
            <p>
              macOS tags anything a browser downloads as "from the internet". This removes that tag from <code>Mercury.app</code>,
              and only from it. It changes no system setting and leaves Gatekeeper on for every other app.
            </p>
          </div>
          <div>
            <h3>Why it's safe</h3>
            <p>
              Mercury is open source: every line is on <a href="https://github.com/cosmicstack-labs/mercury-agent" target="_blank" rel="noopener noreferrer">GitHub</a>,
              and every release file comes from GitHub's own build with a published SHA-256 checksum. Updates after this
              are signed and checked before they install.
            </p>
          </div>
          <div>
            <h3>What you'll see without it</h3>
            <p>
              "Apple could not verify Mercury…" when you open it. That works too: click <strong>Done</strong>, then
              System Settings → Privacy &amp; Security → <strong>Open Anyway</strong>.
            </p>
          </div>
        </div>

        <div className="mx-dmg__skip">
          <p><strong>Or skip all of this.</strong> This installs Mercury and opens it with no prompt, after checking the download:</p>
          <CopyLine cmd={MAC_INSTALL} label="Copy the install command" />
        </div>

        <div className="mx-dmg__actions">
          <a href="/docs/desktop/macos" className="mx-dmg__help">Mac guide &amp; fixes</a>
          <button type="button" className="mx-dmg__cancel" onClick={() => setOpen(false)}>Cancel</button>
          <a href={href} className="mx-dmg__go" onClick={() => setTimeout(() => setOpen(false), 400)}>Download the .dmg ({chip})</a>
        </div>
      </div>
    </div>
  ) : null;

  return (
    <>
      <a href={href} className={className} data-asset={assetKey} onClick={(e) => { e.preventDefault(); setOpen(true); }}>{children}</a>
      {dialog}
    </>
  );
}
