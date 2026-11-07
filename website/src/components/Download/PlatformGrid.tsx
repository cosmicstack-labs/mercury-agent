import React from 'react';
import MacDmgLink from './MacDmgLink';
import clsx from 'clsx';
import { AppleIcon, LinuxIcon, WindowsIcon } from './DesktopDownload';
import { asset, sizeOf, type AssetKey } from './release';

/** One button per computer: whichever the visitor has, every choice is one click away. */
const PLATFORMS: { key: AssetKey; os: string; what: string; icon: React.ReactNode }[] = [
  { key: 'macos-arm64', os: 'macOS', what: 'Apple Silicon', icon: <AppleIcon /> },
  { key: 'macos-x64', os: 'macOS', what: 'Intel', icon: <AppleIcon /> },
  { key: 'windows-x64-setup', os: 'Windows', what: 'x64 installer', icon: <WindowsIcon /> },
  { key: 'linux-appimage', os: 'Linux', what: 'AppImage', icon: <LinuxIcon /> },
];

export default function PlatformGrid({ className }: { className?: string }): React.ReactElement {
  return (
    <ul className={clsx('mx-platforms', className)} aria-label="Mercury Desktop for every platform">
      {PLATFORMS.map((p) => {
        const a = asset(p.key);
        if (!a) return null;
        const size = sizeOf(a);
        return (
          <li key={p.key}>
            <MacDmgLink assetKey={p.key} href={a.url} className="mx-platforms__item">
              <span className="mx-platforms__icon">{p.icon}</span>
              <span className="mx-platforms__text">
                <span className="mx-platforms__os">{p.os}</span>
                <span className="mx-platforms__what">{p.what}{size && ` · ${size}`}</span>
              </span>
            </MacDmgLink>
          </li>
        );
      })}
    </ul>
  );
}
