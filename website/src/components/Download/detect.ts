/**
 * Which computer is this page open on? Decided in the browser only (the
 * static HTML shows a neutral button, so a crawler or a no-JS reader still
 * gets a working link to /download).
 *
 * 1. Chromium browsers expose `navigator.userAgentData`; its high-entropy
 *    `platform` and `architecture` tell Apple Silicon from Intel and spot
 *    phones (`mobile`).
 * 2. Everything else (Safari, Firefox) falls back to the user agent. Safari
 *    and Firefox report "Intel Mac" even on Apple Silicon, so a Mac whose
 *    chip can't be read defaults to Apple Silicon (most Macs sold since
 *    2021) with Intel as the second link. The WebGL renderer name breaks
 *    the tie when the browser shares it ("Apple M2" vs "Intel Iris").
 * 3. iPadOS claims to be a Mac; a "Mac" with a touch screen is a tablet.
 */

export type DetectedOs = 'macos' | 'windows' | 'linux' | 'mobile' | 'unknown';

export interface Detected {
  os: DetectedOs;
  /** For macOS: true = Apple Silicon, false = Intel, null = couldn't tell (treated as Apple Silicon). */
  appleSilicon: boolean | null;
  /** Windows on ARM: the x64 build runs under emulation. */
  windowsArm: boolean;
}

export const UNKNOWN: Detected = { os: 'unknown', appleSilicon: null, windowsArm: false };

interface UADataLike {
  mobile?: boolean;
  platform?: string;
  getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; platform?: string; bitness?: string }>;
}

/** Apple Silicon from the GPU name, when the browser shares it. */
function gpuSaysAppleSilicon(): boolean | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    if (/apple m\d|apple gpu/i.test(renderer)) return true;
    if (/intel|amd|radeon|nvidia/i.test(renderer)) return false;
  } catch {
    /* no WebGL: can't tell */
  }
  return null;
}

export function fromUserAgent(ua: string, maxTouchPoints = 0): Detected {
  if (/iphone|ipad|ipod|android|mobile/i.test(ua)) return { ...UNKNOWN, os: 'mobile' };
  if (/macintosh|mac os x/i.test(ua)) {
    if (maxTouchPoints > 1) return { ...UNKNOWN, os: 'mobile' }; // iPadOS
    return { os: 'macos', appleSilicon: null, windowsArm: false };
  }
  if (/windows/i.test(ua)) return { os: 'windows', appleSilicon: null, windowsArm: /arm64|aarch64/i.test(ua) };
  if (/cros|linux|x11/i.test(ua)) return { ...UNKNOWN, os: 'linux' };
  return UNKNOWN;
}

export async function detect(): Promise<Detected> {
  if (typeof navigator === 'undefined') return UNKNOWN;
  const base = fromUserAgent(navigator.userAgent, navigator.maxTouchPoints || 0);
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (uaData?.mobile) return { ...UNKNOWN, os: 'mobile' };

  if (uaData?.getHighEntropyValues) {
    try {
      const v = await uaData.getHighEntropyValues(['architecture', 'platform', 'bitness']);
      const platform = (v.platform || uaData.platform || '').toLowerCase();
      const arm = (v.architecture || '').toLowerCase() === 'arm';
      if (platform === 'macos') return { os: 'macos', appleSilicon: v.architecture ? arm : gpuSaysAppleSilicon(), windowsArm: false };
      if (platform === 'windows') return { os: 'windows', appleSilicon: null, windowsArm: arm };
      if (platform === 'linux' || platform === 'chrome os' || platform === 'chromeos') return { ...UNKNOWN, os: 'linux' };
      if (platform === 'android' || platform === 'ios') return { ...UNKNOWN, os: 'mobile' };
    } catch {
      /* hints refused: use the user agent */
    }
  }
  if (base.os === 'macos') return { ...base, appleSilicon: gpuSaysAppleSilicon() };
  return base;
}
