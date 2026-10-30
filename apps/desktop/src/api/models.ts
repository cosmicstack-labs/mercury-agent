import { ApiError, apiUrl, authHeaders, http, request } from "./client";
import type { PluginItem } from "./types";

/** Model providers and gateways (GET/POST /api/providers*), voice key checks, and Optimus voice settings. */

export type ProviderKind = "cloud" | "gateway" | "local" | "account";

export interface ProviderInfo {
  id: string;
  label: string;
  kind: ProviderKind;
  blurb: string;
  needsKey: boolean;
  needsBaseUrl: boolean;
  signInOnly: boolean;
  keyUrl: string | null;
  keyHint: string | null;
  /** Masked: "sk-a••••b3c4". Never send it back. */
  apiKey: string;
  hasKey: boolean;
  baseUrl: string;
  model: string;
  enabled: boolean;
  configured: boolean;
  isDefault: boolean;
  recommended: boolean;
}

export interface ProviderSettings {
  providers: ProviderInfo[];
  default: { provider: string; model: string };
  roles: { learning: string | null; crew: string | null };
  setupRequired: boolean;
}

export type CheckField = "apiKey" | "baseUrl";
export interface ProviderCheck {
  ok: boolean;
  models?: string[];
  recommendedModel?: string;
  error?: string;
  field?: CheckField;
  ms?: number;
}

export interface SaveResult {
  success: boolean;
  provider?: ProviderInfo;
  applied: boolean;
  restarting?: boolean;
  restartRequired?: boolean;
  error?: string;
}

export interface VoiceCheck {
  ok: boolean;
  verified: boolean;
  message: string;
  voices?: Array<{ id: string; name: string }>;
  models?: string[];
}

export type VoiceVendor = "elevenlabs" | "deepgram" | "assemblyai" | "cartesia" | "gemini" | "qwen" | "azure" | "sarvam" | "minimax";

/** Optimus settings, with the fields the voice screen needs (when, options, labels). */
export interface VoiceField {
  key: string;
  type: "string" | "number" | "boolean" | "enum" | "secret";
  label?: string;
  description?: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  examples?: string[];
  value?: unknown;
  isSet?: boolean;
  required?: boolean;
  group?: string;
  when?: Record<string, string | string[]> | Array<Record<string, string | string[]>>;
}
export type VoicePlugin = Omit<PluginItem, "settings"> & { settings?: VoiceField[]; settingGroups?: Array<{ id: string; label: string; description?: string; ready: boolean }>; missing?: Array<{ key: string; needs: string; fix: string }> };

const enc = encodeURIComponent;

export const modelsApi = {
  settings: () => http.get<ProviderSettings>("/api/providers/settings"),
  /** Live check of what's typed (unsaved). An omitted key means "the saved one". */
  check: (id: string, draft: { apiKey?: string; baseUrl?: string }) => http.post<ProviderCheck>(`/api/providers/${enc(id)}/check`, draft),
  save: (id: string, patch: { apiKey?: string; baseUrl?: string; model?: string; enabled?: boolean }) => http.post<SaveResult>(`/api/providers/${enc(id)}`, patch),
  forget: (id: string) => http.delete<SaveResult>(`/api/providers/${enc(id)}/key`),
  roles: (body: { default?: { provider: string; model?: string }; learning?: string | null; crew?: string | null }) => http.put<SaveResult>("/api/providers/roles", body),
};

export const voiceApi = {
  check: (vendor: VoiceVendor, key?: string, endpoint?: string) => http.post<VoiceCheck>("/api/voice/check", { vendor, key, endpoint }),
  /** null when Optimus (which carries voice) isn't installed. */
  plugin: () => http.get<{ plugin: VoicePlugin | null }>("/api/plugins/optimus").then((r) => r.plugin),
  set: (key: string, value: unknown) => http.post<{ ok: boolean }>("/api/plugins/optimus/settings", { key, value }),
};

/** Does a plugin field apply, given the current values? (Mirrors the runtime's `whenMatches`.) */
export function fieldApplies(f: VoiceField, values: Record<string, unknown>): boolean {
  if (!f.when) return true;
  const conds = Array.isArray(f.when) ? f.when : [f.when];
  return conds.some((c) => Object.entries(c).every(([k, want]) => {
    const v = String(values[k]);
    return Array.isArray(want) ? want.includes(v) : v === String(want);
  }));
}

/** GET /api/cloud/status: is Mercury Cloud working, and what to do if not. */
export interface CloudStatus {
  paired: boolean;
  enabled: boolean;
  isDefault: boolean;
  tier: string | null;
  model: string;
  modelOk: boolean;
  chat: { ok: boolean; models: string[]; error: string | null };
  /** The agent's live connection to Cloud. */
  session: "online" | "offline" | "signed-out" | "off";
  sessionError: string | null;
  /** Has the long-lived key that renews an expired session by itself. */
  selfRecovers: boolean;
  action: "sign-in" | "pick-model" | null;
  signin: CloudSignIn | null;
}
export interface CloudSignIn { code: string; pairingUrl: string; status: "pending" | "done" | "failed"; error: string | null; upgradeUrl: string | null }

export const cloudApi = {
  status: (fresh = false) => http.get<CloudStatus>(`/api/cloud/status${fresh ? "?fresh=1" : ""}`),
  startSignIn: () => http.post<CloudSignIn>("/api/cloud/signin"),
  signIn: () => http.get<CloudSignIn | { status: "none" }>("/api/cloud/signin"),
  cancelSignIn: () => http.delete<{ ok: boolean }>("/api/cloud/signin"),
  /** Use Cloud for chat or not; you stay signed in either way. 409 when it's the only model. */
  setEnabled: (enabled: boolean) => http.post<{ ok: boolean; enabled: boolean; default: string }>("/api/cloud/enabled", { enabled }),
  /** Forget the Cloud sign-in on this computer; Mercury restarts. */
  signOut: () => http.post<{ ok: boolean; restarting: boolean; fallback: string | null; setupNext: boolean }>("/api/cloud/signout"),
};

/** Dictation: GET tells whether a speech service is set up; POST sends raw audio and gets text back. */
export const speakApi = {
  status: () => http.get<{ available: boolean; engine: string | null; maxChars: number }>("/api/speak"),
  /** MP3 for one part of a reply (at most `maxChars`). */
  audio: async (text: string, signal?: AbortSignal): Promise<Blob> => {
    const res = await fetch(apiUrl("/api/speak"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "audio/mpeg, application/json", ...authHeaders() },
      body: JSON.stringify({ text }),
      signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string } & Record<string, unknown>;
      throw new ApiError(body.error || `Request failed (${res.status})`, res.status, null, body);
    }
    return res.blob();
  },
};

export const transcribeApi = {
  status: () => http.get<{ available: boolean; engine: string | null }>("/api/transcribe"),
  send: (audio: Blob, language?: string) =>
    request<{ text: string; engine: string }>(`/api/transcribe${language ? `?language=${encodeURIComponent(language)}` : ""}`, {
      method: "POST",
      body: audio,
      headers: { "Content-Type": audio.type || "audio/webm" },
    }),
};
