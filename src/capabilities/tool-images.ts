import { ScopedValue } from '../utils/turn-scope.js';
import type { ImageRoute, ScreenshotBox, VisionProfile } from '../core/vision-profile.js';

export interface ToolImage {
  data: string;
  mimeType: string;
}

export type ToolImageOutput =
  | { type: 'text'; value: string }
  | {
      type: 'content';
      value: Array<{ type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string }>;
    };

export const TOOL_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const MAX_TOOL_IMAGES = 4;
export const MAX_TOOL_IMAGE_CHARS = 8_000_000;
const MAX_PENDING = 32;

const pendingImages = new Map<string, ToolImage[]>();
/**
 * How the calling turn's model takes images, and the screenshot size it is
 * best served by (ADR-043; per turn once claimed, ADR-037).
 */
const vision = new ScopedValue<Pick<VisionProfile, 'route' | 'box'>>({ route: 'tool-result', box: { width: 1280, height: 800 } });

export function setToolVision(profile: Pick<VisionProfile, 'route' | 'box'>): void {
  vision.set({ route: profile.route, box: profile.box });
}

/** Older callers: a yes/no for "the model sees images in tool results". */
export function setToolImagesAllowed(allowed: boolean): void {
  vision.set({ ...vision.get(), route: allowed ? 'tool-result' : 'none' });
}

export function toolImagesAllowed(): boolean {
  return vision.get().route !== 'none';
}

export function toolImageRoute(): ImageRoute {
  return vision.get().route;
}

/**
 * What a screenshot-taking tool is asked for (passed as `mercury_screenshot`
 * to plugin tools that declare `screenshots: true`): the size, and whether
 * to take one at all.
 */
export function screenshotRequest(): { include: boolean; max_width: number; max_height: number } {
  const { route, box } = vision.get();
  return { include: route !== 'none', max_width: box.width, max_height: box.height };
}

export function screenshotBox(): ScreenshotBox {
  return vision.get().box;
}

/** Give the calling turn its own image settings (no-op outside a turn). */
export function claimToolImagesForTurn(): void {
  vision.claim();
}

/** Images a tool call returned, for showing them after its result (route user-message). */
export function heldImages(toolCallId: string): ToolImage[] | undefined {
  return pendingImages.get(toolCallId);
}

export function usableImages(images: ToolImage[]): ToolImage[] {
  return images
    .filter((image) => TOOL_IMAGE_TYPES.has(image.mimeType) && image.data.length <= MAX_TOOL_IMAGE_CHARS)
    .slice(0, MAX_TOOL_IMAGES);
}

export function holdImages(toolCallId: string | undefined, images: ToolImage[]): void {
  if (!toolCallId || !images.length) return;
  pendingImages.set(toolCallId, images);
  while (pendingImages.size > MAX_PENDING) pendingImages.delete(pendingImages.keys().next().value as string);
}

export function attachedImagesNote(count: number): string {
  return count ? `\n[${count} image${count > 1 ? 's' : ''} attached]` : '';
}

export function toolOutputWithImages(toolCallId: string, text: string): ToolImageOutput {
  const images = pendingImages.get(toolCallId);
  if (!images?.length) return { type: 'text', value: text };
  const route = vision.get().route;
  if (route === 'none') {
    return { type: 'text', value: `${text}\n(The current model can't view images, so the attached image was left out. Say so if it matters.)` };
  }
  if (route === 'user-message') {
    // This API takes images only from the user: the screenshot follows as its own message (payload-policy.ts).
    return { type: 'text', value: `${text}\n(The screenshot follows as an image.)` };
  }
  return {
    type: 'content',
    value: [{ type: 'text', text }, ...images.map((image) => ({ type: 'image-data' as const, data: image.data, mediaType: image.mimeType }))],
  };
}

export function resetToolImages(): void {
  pendingImages.clear();
}
