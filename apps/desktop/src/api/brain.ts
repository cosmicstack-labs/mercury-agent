/* The second brain's endpoints (beliefs, people, graph, checks). */

import { http } from "./client";

export interface BrainMemory {
  id: string;
  type: string;
  summary: string;
  detail: string | null;
  scope?: string;
  evidenceKind?: string;
  source?: string;
  confidence: number;
  importance: number;
  evidenceCount?: number;
  dismissed?: boolean;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
}

export interface PersonMeta {
  phone?: string;
  email?: string;
  birthday?: string;
  location?: string;
  company?: string;
  role?: string;
  notes?: string;
  links?: string[];
}

export type PersonTier = "known" | "shadow" | "faint";

/** How sure Mercury is that this is someone in your life (runtime person-standing.ts). */
export interface PersonStanding {
  score: number;
  tier: PersonTier;
  reasons: string[];
}

export interface BrainPerson {
  id: string;
  name: string;
  canonicalName: string;
  relationship?: string;
  summary?: string;
  confidence: number;
  memoryCount: number;
  kind: "person" | "pet" | "unverified";
  verifiedBy: "owner" | "model" | "model-rejected" | null;
  meta: PersonMeta;
  ownerEdited: boolean;
  standing?: PersonStanding | null;
  /** "one": a relation only one person can hold (wife, mother); "many": friends, children. */
  cardinality?: "one" | "many" | null;
  firstSeenAt: number;
  lastSeenAt: number;
  connections?: Array<{ id: string; name?: string; display_name?: string; relation_type?: string; strength?: number }>;
}

export interface BrainGraphData {
  persons: Array<{ id: string; name: string; kind: string; relationship: string | null; memoryCount: number; tier?: PersonTier; score?: number }>;
  memories: Array<{ id: string; summary: string; type: string; importance: number; updatedAt: number }>;
  memoryPersons: Array<{ memoryId: string; personId: string; role: string }>;
  relationships: Array<{ source: string; target: string; type: string; strength: number }>;
  available: boolean;
}

/** The knowledge map (GET /api/brain/map): themes → sub-themes → notes, with sparse "related" links. */
export interface BrainMap {
  themes: Array<{ id: string; label: string; terms: string[]; parent: string | null; size: number }>;
  /** note id → the theme (or sub-theme) it sits in. */
  placement: Record<string, string>;
  links: Array<{ a: string; b: string; w: number }>;
  notes: Array<{ id: string; text: string; kind: string; at: number; confidence: number; archived: boolean }>;
  stats: { notes: number; links: number; themes: number; ms: number };
  available: boolean;
}

export interface CheckStatus {
  enabled: boolean;
  pending: number;
  callsToday: number;
  dailyCap: number;
  lastRunAt: number | null;
  lastError: string | null;
  nextRunAt: number | null;
  checked: number;
}

export const MEMORY_TYPES = ["identity", "preference", "goal", "project", "habit", "decision", "constraint", "relationship", "episode", "reflection"] as const;

export const brain = {
  status: () => http.get<{ available: boolean; total?: number }>("/api/brain/status"),
  memories: (opts: { limit?: number; offset?: number; type?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.type) qs.set("type", opts.type);
    if (opts.q) qs.set("q", opts.q);
    return http.get<{ memories: BrainMemory[]; total: number }>(`/api/brain/memory?${qs}`);
  },
  search: (q: string, limit = 40) => http.get<{ memories: BrainMemory[] }>(`/api/brain/memory/search?q=${encodeURIComponent(q)}&limit=${limit}`),
  memory: (id: string) => http.get<BrainMemory>(`/api/brain/memory/${encodeURIComponent(id)}`),
  updateMemory: (id: string, patch: Partial<Pick<BrainMemory, "summary" | "detail" | "importance" | "confidence">>) => http.put<{ success: boolean }>(`/api/brain/memory/${encodeURIComponent(id)}`, patch),
  deleteMemory: (id: string) => http.delete<{ success: boolean }>(`/api/brain/memory/${encodeURIComponent(id)}`),
  addMemory: (body: { type: string; summary: string; detail?: string }) => http.post<BrainMemory>("/api/brain/memory", body),

  persons: (opts: { q?: string; kind?: string; limit?: number; tier?: PersonTier } = {}) => {
    const qs = new URLSearchParams();
    if (opts.q) qs.set("q", opts.q);
    if (opts.kind) qs.set("kind", opts.kind);
    if (opts.tier) qs.set("tier", opts.tier);
    qs.set("limit", String(opts.limit ?? 200));
    return http.get<{ persons: BrainPerson[] }>(`/api/brain/persons?${qs}`);
  },
  person: (id: string) => http.get<{ person: BrainPerson }>(`/api/brain/persons/${encodeURIComponent(id)}`),
  /** Paged; `total` is everything that mentions them (no upper bound). */
  personMemories: (id: string, offset = 0, limit = 50) =>
    http.get<{ memories: BrainMemory[]; total?: number }>(`/api/brain/persons/${encodeURIComponent(id)}/memories?limit=${limit}&offset=${offset}`),
  /** A one-to-one relation someone else holds fails with 409 ("Heer is already your wife."); `force` moves it. */
  updatePerson: (id: string, patch: { name?: string; relationship?: string | null; summary?: string | null; kind?: string; meta?: PersonMeta; force?: boolean }) =>
    http.patch<{ person?: BrainPerson; removed?: boolean }>(`/api/brain/persons/${encodeURIComponent(id)}`, patch),
  mergePerson: (id: string, into: string) => http.post<{ person: BrainPerson | null }>(`/api/brain/persons/${encodeURIComponent(id)}/merge`, { into }),
  notAPerson: (id: string) => http.patch<{ removed?: boolean }>(`/api/brain/persons/${encodeURIComponent(id)}`, { kind: "not_person" }),

  checks: () => http.get<CheckStatus>("/api/brain/persons/checks"),
  runCheck: () => http.post<{ checked: number; status: CheckStatus }>("/api/brain/persons/checks/run"),
  queueExisting: () => http.post<{ queued: number; status: CheckStatus | null }>("/api/brain/persons/checks/queue-existing"),

  map: (archive = false) => http.get<BrainMap>(`/api/brain/map${archive ? "?archive=1" : ""}`),
  graph: (memories = 300, shadows = false) => http.get<BrainGraphData>(`/api/brain/graph/v2?memories=${memories}${shadows ? "&shadows=1" : ""}`),
  relations: () => http.get<{ relations: Array<{ label: string; cardinality: "one" | "many" }> }>("/api/brain/relations"),
};
