import React, { useEffect, useState } from 'react';
import clsx from 'clsx';

type Method = 'shell' | 'powershell' | 'npm' | 'bun';

const METHODS: { id: Method; label: string; cmd: string; note: React.ReactNode }[] = [
  {
    id: 'shell',
    label: 'macOS / Linux',
    cmd: 'curl -fsSL https://mercuryagent.sh/install.sh | sh',
    note: <>Standalone binary, no Node.js needed. <a href="/install.sh">Read the script first</a>.</>,
  },
  {
    id: 'powershell',
    label: 'Windows',
    cmd: 'irm https://mercuryagent.sh/install.ps1 | iex',
    note: <>Standalone binary, no Node.js needed. <a href="/install.ps1">Read the script first</a>.</>,
  },
  {
    id: 'npm',
    label: 'npm',
    cmd: 'npm i -g @cosmicstack/mercury-agent',
    note: <>Requires Node.js 20+. Then run <code>mercury</code>.</>,
  },
  {
    id: 'bun',
    label: 'bun',
    cmd: 'bun add -g @cosmicstack/mercury-agent',
    note: <>Then run <code>mercury</code>. The setup wizard takes about a minute.</>,
  },
];

export default function InstallCommand({ className }: { className?: string }): React.ReactElement {
  const [method, setMethod] = useState<Method>('shell');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (/win/i.test(navigator.userAgent) && !/darwin|mac/i.test(navigator.userAgent)) setMethod('powershell');
  }, []);

  const current = METHODS.find((m) => m.id === method)!;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command is selectable text anyway */
    }
  };

  return (
    <div className={clsx('mx-install', className)}>
      <div className="mx-install__tabs" role="tablist" aria-label="Install method">
        {METHODS.map((m) => (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={m.id === method}
            className={clsx('mx-install__tab', m.id === method && 'is-active')}
            onClick={() => setMethod(m.id)}
          >
            {m.label}
          </button>
        ))}
      </div>
      <div className="mx-install__cmd">
        <span className="mx-install__prompt" aria-hidden="true">{method === 'powershell' ? 'PS>' : '$'}</span>
        <code>{current.cmd}</code>
        <button type="button" className="mx-install__copy" onClick={copy} aria-label="Copy install command">
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <p className="mx-install__note">{current.note}</p>
    </div>
  );
}
