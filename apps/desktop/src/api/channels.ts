import { http } from "./client";

/** Messaging channels Mercury runs itself (GET/PUT /api/channels*). WhatsApp is a plugin. */
export type ChannelType = "telegram" | "discord" | "slack" | "signal";

export interface ChannelPerson { id: string; name: string; detail?: string; role: "admin" | "member"; since?: string }
export interface ChannelPending { id: string; name: string; detail?: string; code?: string; requestedAt?: string }

export interface ChannelInfo {
  type: ChannelType;
  label: string;
  enabled: boolean;
  configured: boolean;
  running: boolean;
  /** Keys masked ("1234••••abcd"); has* tells whether one is saved. */
  settings: Record<string, string | boolean>;
  access: { admins: ChannelPerson[]; members: ChannelPerson[]; pending: ChannelPending[] };
}

export interface ChannelCheck { ok: boolean; identity?: string; message: string; field?: string }
export interface SignalLink { status: "none" | "starting" | "waiting" | "linked" | "failed"; uri?: string; qrImage?: string; phoneNumber?: string; error?: string }

export type AccessAction = "approve" | "reject" | "remove" | "promote" | "demote" | "reset";

export const channelsApi = {
  list: () => http.get<{ channels: ChannelInfo[]; liveRestart: boolean }>("/api/channels"),
  check: (type: ChannelType, draft: Record<string, unknown>) => http.post<ChannelCheck>(`/api/channels/${type}/check`, draft),
  save: (type: ChannelType, patch: Record<string, unknown>) =>
    http.put<{ ok: boolean; channel: ChannelInfo; identity?: string; running: boolean; error?: string; restartRequired: boolean }>(`/api/channels/${type}`, patch),
  access: (type: ChannelType, action: AccessAction, id?: string, role?: "admin" | "member") =>
    http.post<{ ok: boolean; channel: ChannelInfo }>(`/api/channels/${type}/access`, { action, id, role }),
  linkSignal: () => http.post<SignalLink>("/api/channels/signal/link"),
  signalLink: () => http.get<SignalLink>("/api/channels/signal/link"),
};
