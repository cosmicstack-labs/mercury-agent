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
  /** Where Mercury saves what it makes (~/mercury-artifacts), and files it left loose in the home folder. */
  folder: () => http.get<{ path: string; display: string; exists: boolean; strays: Array<{ id: string; name: string; path: string; threadId: string; threadTitle: string | null }> }>("/api/artifacts/folder"),
  /** Move those loose files into their chats' folders. */
  tidy: () => http.post<{ moved: Array<{ name: string; to: string }>; failed: Array<{ name: string; error: string }> }>("/api/artifacts/folder/tidy", {}),
  /** Save a copy on this computer; `as` makes a Markdown/text artifact a PDF or Word document. */
  exportTo: (id: string, dest: string, as?: "pdf" | "docx") => http.post<{ ok: boolean; path: string }>(`/api/artifacts/${encodeURIComponent(id)}/export`, { dest, ...(as ? { as } : {}) }),
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

/** Markdown and text can also be saved as a PDF or a Word document. */
export function canExportAsDocument(a: { name: string; mime: string }): boolean {
  return /^text\/(markdown|plain)$/.test(a.mime) || /\.(md|markdown|txt)$/i.test(a.name);
}

export type ExportFormat = "original" | "pdf" | "docx";

const FORMAT_LABEL: Record<Exclude<ExportFormat, "original">, string> = { pdf: "PDF", docx: "Word document" };

export function exportName(name: string, format: ExportFormat): string {
  return format === "original" ? name : `${name.replace(/\.(md|markdown|txt)$/i, "")}.${format}`;
}

/**
 * Save an artifact as itself, a PDF or a Word document: a Save dialog when
 * Mercury runs on this computer (the runtime writes the file), a download
 * otherwise. Resolves where it went ("" for a download), or null when the
 * dialog was cancelled.
 */
export async function exportArtifact(a: { id: string; name: string }, format: ExportFormat, local: boolean, tauri: boolean): Promise<string | null> {
  const as = format === "original" ? undefined : format;
  const name = exportName(a.name, format);
  if (tauri && local) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const ext = name.split(".").pop() ?? "";
    const dest = await save({ defaultPath: name, title: `Save ${as ? FORMAT_LABEL[as] : name}`, filters: ext ? [{ name: as ? FORMAT_LABEL[as] : ext.toUpperCase(), extensions: [ext] }] : undefined });
    if (!dest) return null;
    await artifactsApi.exportTo(a.id, dest, as);
    return dest;
  }
  const r = await fetch(apiUrl(`/api/artifacts/${encodeURIComponent(a.id)}/file${as ? `?as=${as}` : "?download=1"}`), { headers: authHeaders() });
  if (!r.ok) {
    let message = `Couldn't make the file (${r.status})`;
    try { message = ((await r.json()) as { error?: string }).error ?? message; } catch { /* not JSON */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await r.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return "";
}

/**
 * A site's icon as a blob URL, through the runtime (GET /api/chat/favicon):
 * the app itself never loads anything from a third party. null = no icon.
 */
const icons = new Map<string, Promise<string | null>>();
export function faviconUrl(domain: string): Promise<string | null> {
  const key = domain.toLowerCase();
  let hit = icons.get(key);
  if (!hit) {
    hit = fetch(apiUrl(`/api/chat/favicon?domain=${encodeURIComponent(key)}`), { headers: authHeaders() })
      .then(async (r) => (r.status === 200 ? URL.createObjectURL(await r.blob()) : null))
      .catch(() => null);
    icons.set(key, hit);
    if (icons.size > 300) {
      const [oldest, url] = icons.entries().next().value as [string, Promise<string | null>];
      icons.delete(oldest);
      void url.then((u) => { if (u) URL.revokeObjectURL(u); });
    }
  }
  return hit;
}
