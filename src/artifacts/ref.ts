import type { ArtifactKind } from './classify.js';
import type { Artifact } from './store.js';

/** What a message or an event carries about an artifact (never the stored path). */
export interface ArtifactRef { id: string; name: string; kind: ArtifactKind; mime: string; size: number; path: string }

export function artifactRef(a: Artifact): ArtifactRef {
  return { id: a.id, name: a.name, kind: a.kind, mime: a.mime, size: a.size, path: a.originalPath };
}

const LABEL: Record<ArtifactKind, string> = { image: 'image', video: 'video', audio: 'audio', pdf: 'PDF', document: 'document', text: 'notes', file: 'file' };
export function artifactKindLabel(kind: ArtifactKind): string {
  return LABEL[kind];
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
