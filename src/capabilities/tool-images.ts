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
let imagesAllowed = true;

export function setToolImagesAllowed(allowed: boolean): void {
  imagesAllowed = allowed;
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
  if (!imagesAllowed) {
    return { type: 'text', value: `${text}\n(The current model can't view images, so the attached image was left out. Say so if it matters.)` };
  }
  return {
    type: 'content',
    value: [{ type: 'text', text }, ...images.map((image) => ({ type: 'image-data' as const, data: image.data, mediaType: image.mimeType }))],
  };
}

export function resetToolImages(): void {
  pendingImages.clear();
}
