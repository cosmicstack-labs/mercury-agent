/* ═══════════════════════════════════════════════════════════════
   Connections — the runtimes this app knows how to reach.

   Metadata (name, URL, kind) lives in the app's store file; the credential
   never does. A remote connection's device token sits in the OS keychain
   under `connection:<id>`; a local connection has no stored credential at
   all — it reads the runtime's per-boot attach token each time.
   ═══════════════════════════════════════════════════════════════ */

import { create } from "zustand";
import { desktop, isTauri } from "./tauri";

export type ConnectionKind = "local" | "remote";

export interface Connection {
  id: string;
  kind: ConnectionKind;
  name: string;
  /** Origin, no trailing slash: http://127.0.0.1:6174, https://mercury.tail1234.ts.net */
  baseUrl: string;
  /** The runtime's record of this device (remote only). */
  deviceId?: string;
  createdAt: string;
  lastUsedAt?: string;
}

interface PersistedShape {
  version: 1;
  connections: Connection[];
  activeId: string | null;
}

interface ConnectionsState {
  loaded: boolean;
  connections: Connection[];
  activeId: string | null;
  load(): Promise<void>;
  add(connection: Omit<Connection, "createdAt">, token?: string | null): Promise<Connection>;
  remove(id: string): Promise<void>;
  setActive(id: string | null): Promise<void>;
  rename(id: string, name: string): Promise<void>;
}

export const LOCAL_CONNECTION_ID = "local";
const STORE_FILE = "connections.json";
const STORE_KEY = "state";
const DEV_STORAGE_KEY = "mercury-desktop-connections";

export function secretKeyFor(id: string): string {
  return `connection:${id}`;
}

async function readPersisted(): Promise<PersistedShape> {
  const empty: PersistedShape = { version: 1, connections: [], activeId: null };
  try {
    if (isTauri) {
      const { load } = await import("@tauri-apps/plugin-store");
      const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
      const raw = await store.get<PersistedShape>(STORE_KEY);
      return sanitize(raw) ?? empty;
    }
    const raw = localStorage.getItem(DEV_STORAGE_KEY);
    return sanitize(raw ? (JSON.parse(raw) as PersistedShape) : null) ?? empty;
  } catch {
    return empty;
  }
}

async function writePersisted(shape: PersistedShape): Promise<void> {
  if (isTauri) {
    const { load } = await import("@tauri-apps/plugin-store");
    const store = await load(STORE_FILE, { defaults: {}, autoSave: false });
    await store.set(STORE_KEY, shape);
    await store.save();
    return;
  }
  try { localStorage.setItem(DEV_STORAGE_KEY, JSON.stringify(shape)); } catch { /* ignore */ }
}

function sanitize(raw: PersistedShape | null | undefined): PersistedShape | null {
  if (!raw || raw.version !== 1 || !Array.isArray(raw.connections)) return null;
  const connections = raw.connections.filter(
    (c): c is Connection =>
      !!c && typeof c.id === "string" && typeof c.baseUrl === "string" && (c.kind === "local" || c.kind === "remote") && typeof c.name === "string"
  );
  const activeId = typeof raw.activeId === "string" && connections.some((c) => c.id === raw.activeId) ? raw.activeId : null;
  return { version: 1, connections, activeId };
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  loaded: false,
  connections: [],
  activeId: null,

  async load() {
    const shape = await readPersisted();
    set({ loaded: true, connections: shape.connections, activeId: shape.activeId });
  },

  async add(connection, token) {
    const full: Connection = { ...connection, createdAt: new Date().toISOString() };
    if (token) await desktop.secretSet(secretKeyFor(full.id), token);
    const connections = [...get().connections.filter((c) => c.id !== full.id), full];
    set({ connections });
    await writePersisted({ version: 1, connections, activeId: get().activeId });
    return full;
  },

  async remove(id) {
    await desktop.secretDelete(secretKeyFor(id)).catch(() => {});
    const connections = get().connections.filter((c) => c.id !== id);
    const activeId = get().activeId === id ? null : get().activeId;
    set({ connections, activeId });
    await writePersisted({ version: 1, connections, activeId });
  },

  async setActive(id) {
    const connections = get().connections.map((c) => (c.id === id ? { ...c, lastUsedAt: new Date().toISOString() } : c));
    set({ activeId: id, connections });
    await writePersisted({ version: 1, connections, activeId: id });
  },

  async rename(id, name) {
    const connections = get().connections.map((c) => (c.id === id ? { ...c, name } : c));
    set({ connections });
    await writePersisted({ version: 1, connections, activeId: get().activeId });
  },
}));

export function newConnectionId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Resolve the credential a connection needs right now. */
export async function credentialFor(connection: Connection): Promise<string | null> {
  if (connection.kind === "local") return desktop.readAttachToken();
  return desktop.secretGet(secretKeyFor(connection.id));
}
