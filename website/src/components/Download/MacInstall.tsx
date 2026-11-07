import React, { useState } from 'react';
import clsx from 'clsx';

export const MAC_INSTALL = 'curl -fsSL https://mercuryagent.sh/install-desktop.sh | sh';

/**
 * The recommended way onto a Mac while the app isn't signed with an Apple
 * Developer ID: a download made with curl isn't marked as coming from the
 * internet, so Gatekeeper doesn't stop the app (scripts/install-desktop.sh).
 */
export default function MacInstall({ className, title = 'Recommended on a Mac' }: { className?: string; title?: string | null }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(MAC_INSTALL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: the command is selectable text */
    }
  };
  return (
    <div className={clsx('mx-install mx-macinstall', className)}>
      {title && <p className="mx-macinstall__title">{title}</p>}
      <div className="mx-install__cmd">
        <span className="mx-install__prompt" aria-hidden="true">$</span>
        <code>{MAC_INSTALL}</code>
        <button type="button" className="mx-install__copy" onClick={copy} aria-label="Copy the Mac install command">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mx-install__note">
        Paste it into Terminal. It picks the build for your Mac, checks the download's SHA-256, installs Mercury in Applications and
        opens it, with no security prompt. <a href="/install-desktop.sh">Read the script first</a> ·{' '}
        <a href="/docs/desktop/macos">Mac guide &amp; fixes</a>.
      </p>
    </div>
  );
}
