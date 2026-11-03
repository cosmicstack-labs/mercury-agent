import React from 'react';
import Link from '@docusaurus/Link';
import MacDmgLink from './MacDmgLink';
import { asset, DESKTOP, LABEL, releaseDate, SERVER, SERVER_LABEL, serverAsset, sizeOf, type AssetKey, type ServerKey } from './release';

const DESKTOP_KEYS: AssetKey[] = ['macos-arm64', 'macos-x64', 'windows-x64-setup', 'windows-x64-msi', 'linux-appimage', 'linux-deb', 'linux-rpm'];
const SERVER_KEYS: ServerKey[] = ['macos-arm64', 'macos-x64', 'linux-x64', 'linux-arm64', 'linux-x64-baseline', 'windows-x64', 'windows-x64-baseline', 'web', 'checksums'];

/**
 * Every download of the current release, for the docs: Mercury Desktop per
 * platform, the server's standalone binaries, npm and the installers.
 * Read from src/data/desktop-release.json, which the release pipeline writes.
 */
export default function ReleaseDownloads(): React.ReactElement {
  const desktop = DESKTOP_KEYS.map((k) => [k, asset(k)] as const).filter(([, a]) => a);
  const server = SERVER_KEYS.map((k) => [k, serverAsset(k)] as const).filter(([, a]) => a);
  return (
    <div className="mx-release-dl">
      <p>
        <strong>Latest: v{DESKTOP.version}</strong>, released {releaseDate()}.{' '}
        <Link to={`/docs/releases/${DESKTOP.version}`}>Release notes</Link> ·{' '}
        <a href={DESKTOP.notesUrl} target="_blank" rel="noopener noreferrer">GitHub release</a> ·{' '}
        <Link to="/download">Download page</Link>
      </p>

      <h3>Mercury Desktop</h3>
      <table>
        <thead><tr><th>System</th><th>Download</th><th>Size</th></tr></thead>
        <tbody>
          {desktop.map(([k, a]) => (
            <tr key={k}>
              <td>{LABEL[k].os}: {LABEL[k].what}<br /><small>{LABEL[k].detail}</small></td>
              <td><MacDmgLink assetKey={k} href={a!.url}><code>{a!.name}</code></MacDmgLink></td>
              <td>{sizeOf(a)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p><small>Not code-signed yet: see <Link to="/docs/desktop/mercury-desktop">Install &amp; first run</Link> for the one-time step on macOS and Windows. Updates are signed and checked before they install.</small></p>

      <h3>Mercury on a server (CLI)</h3>
      <ul>
        <li>macOS / Linux: <code>curl -fsSL https://mercuryagent.sh/install.sh | sh</code></li>
        <li>Windows: <code>irm https://mercuryagent.sh/install.ps1 | iex</code></li>
        <li>npm (Node.js 22+): <code>npm i -g {SERVER.npm}</code></li>
        <li>Already installed: <code>mercury upgrade</code> (it <Link to="/docs/desktop/updating">rolls back on its own</Link> if the new version doesn't start)</li>
      </ul>
      {server.length > 0 && (
        <table>
          <thead><tr><th>Standalone binary</th><th>File</th><th>Size</th></tr></thead>
          <tbody>
            {server.map(([k, a]) => (
              <tr key={k}>
                <td>{SERVER_LABEL[k].os === 'All' ? SERVER_LABEL[k].what : `${SERVER_LABEL[k].os}: ${SERVER_LABEL[k].what}`}</td>
                <td><a href={a!.url}><code>{a!.name}</code></a></td>
                <td>{sizeOf(a)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p><small>The installers download the binary for your computer and check it against <code>checksums.txt</code>.</small></p>
    </div>
  );
}
