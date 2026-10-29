import { apiUrl, authHeaders, http } from "./client";

/** What Mercury made, by conversation (GET /api/artifacts*). */
export type ArtifactKind = "image" | "video" | "audio" | "pdf" | "document" | "text" | "file";

/** What a chat message carries about its artifacts. */
export interface ArtifactRef { id: string; name: string; kind: ArtifactKind; mime: string; size: number; path: string }

export interface ArtifactItem {
  id: string;
  threadId: string;
  threadTitle: string | null;
  threadExists: boolean;
  name: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  originalPath: string;
  originalExists: boolean;
  createdAt: number;
  tool?: string;
  surface?: "chat" | "code";
}

export interface ArtifactPage { items: ArtifactItem[]; nextCursor: string | null; counts: Record<string, number> }

export const artifactsApi = {
  list: (q: { kind?: string; q?: string; threadId?: string; cursor?: string | null; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.kind && q.kind !== "all") p.set("kind", q.kind);
    if (q.q) p.set("q", q.q);
    if (q.threadId) p.set("threadId", q.threadId);
    if (q.cursor) p.set("cursor", q.cursor);
    p.set("limit", String(q.limit ?? 40));
    return http.get<ArtifactPage>(`/api/artifacts?${p}`);
  },
  get: (id: string) => http.get<{ artifact: ArtifactItem }>(`/api/artifacts/${encodeURIComponent(id)}`).then((r) => r.artifact),
  remove: (id: string) => http.delete<{ ok: boolean }>(`/api/artifacts/${encodeURIComponent(id)}`),
  /** Save a copy to a folder on the computer Mercury runs on. */
  exportTo: (id: string, dest: string) => http.post<{ ok: boolean; path: string }>(`/api/artifacts/${encodeURIComponent(id)}/export`, { dest }),
};

/**
 * The file, as a blob URL (an <img> or <video> can't send the auth header).
 * Kept for the session, the oldest released past 40 so memory stays bounded.
 */
const cache = new Map<string, Promise<string | null>>();
export function artifactBlobUrl(id: string): Promise<string | null> {
  let hit = cache.get(id);
  if (!hit) {
    hit = fetch(apiUrl(`/api/artifacts/${encodeURIComponent(id)}/file`), { headers: authHeaders() })
      .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    cache.set(id, hit);
    if (cache.size > 40) {
      const [oldest, url] = cache.entries().next().value as [string, Promise<string | null>];
      cache.delete(oldest);
      void url.then((u) => { if (u) URL.revokeObjectURL(u); });
    }
  }
  return hit;
}

export async function artifactText(id: string, max = 400_000): Promise<string> {
  const r = await fetch(apiUrl(`/api/artifacts/${encodeURIComponent(id)}/file`), { headers: authHeaders() });
  if (!r.ok) throw new Error(`Couldn't load it (${r.status})`);
  const t = await r.text();
  return t.length > max ? `${t.slice(0, max)}\n\n… (cut off here; save the file to read the rest)` : t;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export const KIND_LABEL: Record<ArtifactKind, string> = { image: "Image", video: "Video", audio: "Audio", pdf: "PDF", document: "Document", text: "Notes", file: "File" };
