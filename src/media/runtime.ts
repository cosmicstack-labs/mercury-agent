/**
 * The process's one MediaService, for the parts that aren't handed it
 * directly (slash commands, the web API). Set once at start-up (index.ts).
 */
import type { MediaService } from './service.js';

let service: MediaService | null = null;

export function setMediaService(s: MediaService | null): void {
  service = s;
}

export function mediaService(): MediaService | null {
  return service;
}
