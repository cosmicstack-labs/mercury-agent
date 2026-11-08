import { access, realpath } from 'node:fs/promises';
import { isAbsolute, win32 } from 'node:path';

export function browserCandidates(platform = process.platform, env = process.env): string[] {
  if (platform === 'win32') return [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA]
    .filter((root): root is string => !!root && win32.isAbsolute(root))
    .flatMap((root) => [win32.join(root, 'Google/Chrome/Application/chrome.exe'), win32.join(root, 'Microsoft/Edge/Application/msedge.exe')]);
  if (platform === 'darwin') return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  return ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/microsoft/msedge/msedge'];
}

export async function findBrowser(configured?: string): Promise<string> {
  if (configured && !isAbsolute(configured)) throw new Error('Browser executable must be an absolute path.');
  for (const candidate of configured ? [configured] : browserCandidates()) {
    try { await access(candidate); return await realpath(candidate); } catch { /* try another installed browser */ }
  }
  throw new Error('No installed Chrome, Chromium, or Edge found. Install a browser or set capabilities.browser.executable in permissions.yaml. Mercury does not download one.');
}

export function browserArgs(profile: string, proxyPort: number): string[] {
  return [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-extensions', '--disable-sync', '--disable-default-apps',
    '--disable-quic', '--disable-domain-reliability', '--disable-breakpad', '--disable-crash-reporter',
    '--disable-features=AutofillServerCommunication,MediaRouter,OptimizationHints,Translate,Prerender2',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--proxy-server=http://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
    '--password-store=basic', '--window-size=1280,800', 'about:blank',
  ];
}

/** No provider tokens, SSH agents, cloud credentials, or real profile/home env. */
export function browserEnvironment(profile: string, env = process.env): NodeJS.ProcessEnv {
  return {
    ...(env.SystemRoot ? { SystemRoot: env.SystemRoot } : {}),
    ...(env.WINDIR ? { WINDIR: env.WINDIR } : {}),
    HOME: profile, USERPROFILE: profile, LOCALAPPDATA: profile, APPDATA: profile,
    TMPDIR: profile, TEMP: profile, TMP: profile, XDG_CONFIG_HOME: profile, XDG_CACHE_HOME: profile,
    LANG: 'C.UTF-8',
  };
}
