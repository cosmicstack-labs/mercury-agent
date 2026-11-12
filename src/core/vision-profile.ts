/**
 * How the current model takes screenshots (ADR-043): whether it sees them,
 * how they reach it, and how big they should be.
 *
 * A model is billed for an image by its pixels, by rules that differ per
 * family, so one fixed size (Optimus used 1280×800 for every model) costs
 * far more than needed on some and is never seen at all by others:
 *
 *   Claude   ≈ width × height / 750 tokens        1024×640 ≈ 874 (1280×800: 1,365)
 *   OpenAI   85 + 170 per 512-px tile (high)      1024×640 = 765 (1280×800: 1,105)
 *   Gemini   258 per 768-px tile                   768×480 = 258  (1280×800: 1,032)
 *   Qwen-VL and other local vision models: 28-px patches, slow on big images.
 *
 * Route:
 *   tool-result   the provider takes images inside tool results (Anthropic,
 *                 OpenAI Responses): the screenshot stays with its tool call
 *   user-message  the model sees images but its API only takes them from the
 *                 user (OpenAI-compatible chat: OpenRouter, LiteLLM, Mercury
 *                 Cloud, Ollama, LM Studio…): the screenshot follows the tool
 *                 result as an image message (payload-policy.ts)
 *   none          the model can't see images: no screenshot is taken at all;
 *                 the tool still says which window is in front
 *
 * The size is passed to tools that declare `screenshots: true` in their
 * plugin manifest; they shrink the capture themselves, so the coordinates
 * the model clicks stay in the picture it saw.
 */

export type ImageRoute = 'tool-result' | 'user-message' | 'none';

export interface ScreenshotBox {
  width: number;
  height: number;
}

export interface VisionProfile {
  route: ImageRoute;
  box: ScreenshotBox;
  /** Which pricing rule applied (for logs and estimates). */
  family: 'claude' | 'openai' | 'gemini' | 'patch' | 'default';
}

const BOXES: Record<VisionProfile['family'], ScreenshotBox> = {
  claude: { width: 1024, height: 640 },
  openai: { width: 1024, height: 640 },
  gemini: { width: 768, height: 480 },
  patch: { width: 896, height: 560 },
  default: { width: 1024, height: 640 },
};

/** The family whose image pricing applies to this model id. */
export function visionFamily(model: string): VisionProfile['family'] {
  const m = model.toLowerCase();
  if (/claude/.test(m)) return 'claude';
  if (/gemini|gemma/.test(m)) return 'gemini';
  if (/gpt|chatgpt|(^|[/:])o[1-9]\b|grok/.test(m)) return 'openai';
  if (/qwen|llava|minicpm|internvl|moondream|molmo|pixtral|mistral|llama|nemotron|kimi|glm|(^|[-_.:/])vl($|[-_.:/])/.test(m)) return 'patch';
  return 'default';
}

/** "1280x800" from MERCURY_SCREENSHOT_BOX: the owner's own size for every model. */
function boxOverride(env: string | undefined): ScreenshotBox | undefined {
  const m = /^\s*(\d{3,4})\s*[x×]\s*(\d{3,4})\s*$/i.exec(env ?? '');
  if (!m) return undefined;
  const width = Math.min(Math.max(Number(m[1]), 320), 3840);
  const height = Math.min(Math.max(Number(m[2]), 240), 2160);
  return { width, height };
}

export function visionProfile(input: { model: string; seesImages: boolean; toolResultImages: boolean }, env: NodeJS.ProcessEnv = process.env): VisionProfile {
  const family = visionFamily(input.model);
  const route: ImageRoute = !input.seesImages ? 'none' : input.toolResultImages ? 'tool-result' : 'user-message';
  return { route, family, box: boxOverride(env.MERCURY_SCREENSHOT_BOX) ?? BOXES[family] };
}

/** Roughly what an image of this size costs this family, in input tokens. */
export function estimateImageTokens(family: VisionProfile['family'], w: number, h: number): number {
  switch (family) {
    case 'claude':
      return Math.ceil((w * h) / 750);
    case 'openai': {
      // Fit in 2048², then shortest side to 768, then 512-px tiles.
      let s = Math.min(1, 2048 / Math.max(w, h));
      let [x, y] = [w * s, h * s];
      s = Math.min(1, 768 / Math.min(x, y));
      [x, y] = [x * s, y * s];
      return 85 + 170 * Math.ceil(x / 512) * Math.ceil(y / 512);
    }
    case 'gemini':
      return w <= 384 && h <= 384 ? 258 : 258 * Math.ceil(w / 768) * Math.ceil(h / 768);
    case 'patch':
      return Math.ceil(w / 28) * Math.ceil(h / 28);
    default:
      return Math.ceil((w * h) / 750);
  }
}
