/* The shapes in UPDATES.md, as the desktop reads them. */

export interface ChannelRelease {
  version: string;
  date?: string;
  notes?: string;
  notesUrl?: string;
  /** Server only: false for an hour after its files turned out not to be published yet. */
  downloadable?: boolean;
}

export interface Minimum {
  version: string;
  severity?: "security" | "required";
  reason?: string;
  since?: string;
}

export interface ManifestMessage {
  id: string;
  title: string;
  body?: string;
  level?: "info" | "warning" | "critical";
  apps: Array<"desktop" | "server">;
  versions?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  link?: { label: string; url: string } | null;
  dismissible?: boolean;
}

export interface AppSection {
  channels?: { stable?: ChannelRelease | null; dev?: ChannelRelease | null };
  minimum?: Minimum | null;
}

export interface UpdateManifest {
  schema: number;
  issuedAt: string;
  server?: AppSection;
  desktop?: AppSection;
  messages?: ManifestMessage[];
}

export interface ManifestResult {
  manifest: UpdateManifest | null;
  verified: boolean;
  checkedAt: number | null;
  error: string | null;
}

/* ── the desktop's own update (Rust) ── */

export interface DesktopUpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  notes: string | null;
  ready: boolean;
  partialBytes: number;
}

export interface DesktopUpdateStatus {
  currentVersion: string;
  pending: DesktopUpdateInfo | null;
  downloading: boolean;
  installOnQuit: boolean;
}

export interface DownloadProgress {
  phase: "downloading" | "verifying" | "ready" | "retrying" | "error" | "cancelled";
  version: string;
  downloaded: number;
  total: number | null;
  percent: number | null;
  bytesPerSec: number | null;
  attempt: number;
  message: string;
}

/* ── a server's GET /api/updates ── */

export type JobState =
  | "waiting-idle" | "downloading" | "verifying" | "backing-up" | "stopping"
  | "installing" | "starting" | "checking"
  | "done" | "rolled-back" | "failed" | "cancelled";

export interface UpdateJob {
  id: string;
  from: string;
  to: string;
  state: JobState;
  percent: number | null;
  bytes?: number;
  total?: number;
  message: string;
  startedAt: number;
  updatedAt: number;
  error?: string;
  log: string[];
  attempt: number;
}

export const JOB_FINISHED: JobState[] = ["done", "rolled-back", "failed", "cancelled"];

export interface ServerUpdates {
  current: string;
  channel: "stable" | "dev";
  install: "binary" | "npm" | "source" | "unknown";
  canSelfUpdate: boolean;
  cannotReason?: string;
  latest: ChannelRelease | null;
  updateAvailable: boolean;
  required: (Minimum & { severity: "security" | "required" }) | null;
  manifestVerified: boolean;
  checkedAt: number | null;
  job: UpdateJob | null;
  blocked: { version: string; failures: number; lastError?: string } | null;
  justUpdated: { from: string; to: string; at: number } | null;
  messages: ManifestMessage[];
}
