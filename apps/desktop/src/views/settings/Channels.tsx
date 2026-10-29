import { CheckCircle2, ChevronRight, CircleAlert, ExternalLink, QrCode, RefreshCw, ShieldCheck, UserCheck, UserMinus, UserX } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "~/api/client";
import { channelsApi, type ChannelCheck, type ChannelInfo, type ChannelPending, type ChannelPerson, type ChannelType, type SignalLink } from "~/api/channels";
import * as api from "~/api/mercury";
import type { PluginItem } from "~/api/types";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Field, Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Badge, Segmented, Spinner } from "~/components/ui/bits";
import { ConfirmButton, IconTile } from "~/components/ui/kit";
import { desktop } from "~/shell/tauri";
import { cx } from "~/lib/cx";

/**
 * Channels: the places people talk to Mercury besides this app. Each card
 * sets the channel up (checked live before saving), turns it on or off (it
 * restarts by itself, no Mercury restart), and manages who may talk to
 * Mercury there: requests waiting, admins and members. WhatsApp is a plugin,
 * so its card sends you to Plugins.
 */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const HOW_TO_JOIN: Record<ChannelType, string> = {
  telegram: "People open your bot in Telegram and send /start. Their request shows up here.",
  discord: "In your server, people can talk to Mercury in the channel you set. For private messages they DM the bot /start, and the request shows up here.",
  slack: "People DM the Mercury app /start (the first person becomes the admin). Later requests show up here.",
  signal: "In group mode, people send /pair in the \"Mercury\" group. In private mode, only you (Note to Self) can talk to it.",
};

const SETUP_LINK: Record<ChannelType, { label: string; url: string }> = {
  telegram: { label: "Open @BotFather", url: "https://t.me/BotFather" },
  discord: { label: "Discord Developer Portal", url: "https://discord.com/developers/applications" },
  slack: { label: "Your Slack apps", url: "https://api.slack.com/apps" },
  signal: { label: "About linked devices", url: "https://support.signal.org/hc/en-us/articles/360007320551" },
};

export function ChannelsSettings() {
  const [list, setList] = useState<ChannelInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setList((await channelsApi.list()).channels); setError(null); } catch (e) { setError(errorText(e)); }
  }, []);
  useEffect(() => {
    void load();
    // Requests arrive while you look: keep the lists fresh.
    const t = setInterval(() => void load(), 6000);
    return () => clearInterval(t);
  }, [load]);

  const update = (c: ChannelInfo) => setList((l) => l?.map((x) => (x.type === c.type ? c : x)) ?? null);

  if (error && !list) return <p className="text-sm text-red">Couldn't load channels: {error}{/404|Not found/i.test(error) ? " (update Mercury to manage channels here)" : ""}</p>;
  if (!list) return <Spinner size={16} />;

  const waiting = list.reduce((n, c) => n + c.access.pending.length, 0);
  return (
    <section className="flex flex-col gap-4">
      <p className="text-sm text-ink3">Where people can talk to Mercury besides this app. Changes apply at once; only the channel you change restarts.</p>
      {waiting > 0 && (
        <div className="flex items-center gap-2 rounded-lg border border-amber/40 bg-amber/[0.06] px-3 py-2 text-sm text-ink2">
          <ShieldCheck size={15} className="text-amber" /> {waiting} {waiting === 1 ? "person is" : "people are"} waiting for your approval.
        </div>
      )}
      <WhatsAppCard />
      {list.map((c) => <ChannelCard key={c.type} c={c} onChange={update} />)}
    </section>
  );
}

// ── WhatsApp: a plugin, managed in Plugins ──────────────────────────────────

function WhatsAppCard() {
  const [p, setP] = useState<PluginItem | null | undefined>(undefined);
  const openPlugin = useUi((s) => s.openPlugin);
  const setView = useUi((s) => s.setView);
  useEffect(() => { api.plugins.list().then((r) => setP(r.items.find((x) => x.id === "whatsapp") ?? null)).catch(() => setP(null)); }, []);
  const installed = !!p && p.status !== "available";
  const linked = p?.channel?.state === "connected";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-line bg-surface px-4 py-3">
      <IconTile id="whatsapp" label="WhatsApp" size={36} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-base font-medium text-ink">WhatsApp</span>
          <Badge>plugin</Badge>
          {installed && <Badge tone={linked ? "accent" : "amber"}>{linked ? "linked" : p?.channel?.state ?? (p?.enabled ? "not linked" : "off")}</Badge>}
        </div>
        <p className="text-xs text-ink3">{installed ? "Link the account and manage it in Plugins." : "WhatsApp comes as a plugin. Install it from Plugins, then link a spare number."}</p>
      </div>
      {p === undefined ? <Spinner size={13} /> : installed
        ? <Button size="sm" variant="outline" onClick={() => openPlugin("whatsapp")}>Manage in Plugins <ChevronRight size={13} /></Button>
        : <Button size="sm" variant="primary" onClick={() => setView("plugins")}>Open Plugins <ChevronRight size={13} /></Button>}
    </div>
  );
}

// ── One channel ─────────────────────────────────────────────────────────────

function statusOf(c: ChannelInfo): { label: string; tone: "accent" | "amber" | "neutral" | "red" } {
  if (!c.configured) return { label: "not set up", tone: "neutral" };
  if (!c.enabled) return { label: "off", tone: "neutral" };
  return c.running ? { label: "running", tone: "accent" } : { label: "not running", tone: "red" };
}

function ChannelCard({ c, onChange }: { c: ChannelInfo; onChange: (c: ChannelInfo) => void }) {
  const [open, setOpen] = useState(!c.configured);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; ok: boolean } | null>(null);
  const status = statusOf(c);
  const pending = c.access.pending.length;

  async function toggle(on: boolean) {
    if (on && !c.configured) { setOpen(true); setNote({ text: "Set it up first, then turn it on.", ok: false }); return; }
    setBusy("toggle");
    setNote(null);
    try {
      const r = await channelsApi.save(c.type, { enabled: on });
      onChange(r.channel);
      setNote(on ? (r.running ? { text: `${c.label} is running.`, ok: true } : { text: r.error ?? `${c.label} didn't come up. Check the setup.`, ok: false }) : null);
    } catch (e) { setNote({ text: errorText(e), ok: false }); } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col rounded-xl border border-line bg-surface">
      <div className="flex items-center gap-3 px-4 py-3">
        <IconTile id={c.type} label={c.label} size={36} />
        <button className="min-w-0 flex-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <div className="flex items-center gap-2">
            <span className="text-base font-medium text-ink">{c.label}</span>
            <Badge tone={status.tone === "red" ? "red" : status.tone === "accent" ? "accent" : "neutral"}>{status.label}</Badge>
            {pending > 0 && <Badge tone="amber">{pending} waiting</Badge>}
          </div>
          <p className="text-xs text-ink3">
            {c.configured ? `${c.access.admins.length} admin${c.access.admins.length === 1 ? "" : "s"} · ${c.access.members.length} member${c.access.members.length === 1 ? "" : "s"}` : "Not set up yet"}
          </p>
        </button>
        {busy === "toggle" && <Spinner size={13} />}
        <Switch checked={c.enabled} onCheckedChange={(v) => void toggle(v)} disabled={busy !== null} label={c.enabled ? "On" : "Off"} />
        <button onClick={() => setOpen((o) => !o)} className="text-ink4 hover:text-ink" aria-label={open ? "Collapse" : "Expand"}><ChevronRight size={16} className={cx("transition-transform", open && "rotate-90")} /></button>
      </div>
      {note && <p className={cx("px-4 pb-2 text-sm", note.ok ? "text-accent" : "text-red")}>{note.text}</p>}
      {open && (
        <div className="flex flex-col gap-5 border-t border-line px-4 py-4">
          <SetupForm c={c} onSaved={onChange} />
          {c.configured && <People c={c} onChange={onChange} />}
        </div>
      )}
    </div>
  );
}

// ── Setup: fields, live check, save ─────────────────────────────────────────

interface FieldSpec { key: string; label: string; secret?: boolean; placeholder?: string; hint: string; optional?: boolean }

const FIELDS: Record<ChannelType, FieldSpec[]> = {
  telegram: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "123456789:AAE…", hint: "In Telegram, message @BotFather: /newbot (or /token for an existing bot), then paste the token." },
  ],
  discord: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "MTIz…", hint: "Developer Portal → your application → Bot → Reset Token. Turn on Message Content Intent there too." },
    { key: "guildId", label: "Server ID", optional: true, placeholder: "123456789012345678", hint: "Only answer in this server. Right-click the server → Copy Server ID (turn on Developer Mode first)." },
    { key: "channelId", label: "Channel ID", optional: true, placeholder: "123456789012345678", hint: "Only answer in this channel. Leave empty for any channel the bot can see." },
    { key: "adminRoleName", label: "Admin role", optional: true, placeholder: "Mercury Admin", hint: "Members with this role (or server admins) can approve people and change settings from Discord." },
  ],
  slack: [
    { key: "botToken", label: "Bot token", secret: true, placeholder: "xoxb-…", hint: "Your Slack app → OAuth & Permissions → Bot User OAuth Token." },
    { key: "appToken", label: "App-level token", secret: true, placeholder: "xapp-…", hint: "Basic Information → App-Level Tokens, with connections:write. Turn on Socket Mode." },
    { key: "channelId", label: "Channel ID", optional: true, placeholder: "C0123456789", hint: "Only answer mentions in this channel. Leave empty for every channel the app is in." },
  ],
  signal: [
    { key: "phoneNumber", label: "Phone number", placeholder: "+923001234567", hint: "The Signal account Mercury uses, with country code. Link this computer to it below." },
    { key: "groupName", label: "Group name", optional: true, placeholder: "Mercury", hint: "Group mode: Mercury answers in the Signal group with this name." },
  ],
};

function SetupForm({ c, onSaved }: { c: ChannelInfo; onSaved: (c: ChannelInfo) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [mode, setMode] = useState(String(c.settings.mode ?? "group"));
  const [streaming, setStreaming] = useState(c.settings.streaming !== false);
  const [check, setCheck] = useState<ChannelCheck | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const fields = FIELDS[c.type];

  const valueOf = (f: FieldSpec) => draft[f.key] ?? (f.secret ? "" : String(c.settings[f.key] ?? ""));
  const body = () => {
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const v = draft[f.key];
      if (v === undefined) continue;
      if (f.secret && !v.trim()) continue; // empty keeps the saved key
      out[f.key] = v.trim();
    }
    if (c.type === "signal") out.mode = mode;
    else out.streaming = streaming;
    return out;
  };
  const changed = Object.keys(draft).length > 0 || (c.type === "signal" ? mode !== String(c.settings.mode ?? "group") : streaming !== (c.settings.streaming !== false));

  async function runCheck() {
    setBusy("check");
    setSaved(null);
    try { setCheck(await channelsApi.check(c.type, body())); } catch (e) { setCheck({ ok: false, message: errorText(e) }); } finally { setBusy(null); }
  }

  async function save(enable: boolean) {
    setBusy("save");
    setSaved(null);
    try {
      const r = await channelsApi.save(c.type, { ...body(), ...(enable ? { enabled: true } : {}) });
      onSaved(r.channel);
      setDraft({});
      setCheck(r.identity ? { ok: true, message: `Connected${r.identity ? ` as ${r.identity}` : ""}.` } : null);
      setSaved(r.channel.enabled ? (r.running ? `Saved. ${c.label} is running.` : `Saved, but ${c.label} didn't come up${r.error ? `: ${r.error}` : "."}`) : "Saved. Turn it on when you're ready.");
    } catch (e) {
      const field = e instanceof ApiError ? (e.data.field as string | undefined) : undefined;
      setCheck({ ok: false, message: errorText(e), field });
    } finally { setBusy(null); }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">Setup</span>
        <button className="inline-flex items-center gap-1 text-xs text-accent hover:underline" onClick={() => void desktop.openExternal(SETUP_LINK[c.type].url)}>{SETUP_LINK[c.type].label} <ExternalLink size={11} /></button>
      </div>
      {fields.map((f) => {
        const savedKey = f.secret ? String(c.settings[f.key] ?? "") : "";
        const bad = check && !check.ok && check.field === f.key;
        return (
          <Field key={f.key} label={f.optional ? `${f.label} (optional)` : f.label} htmlFor={`${c.type}-${f.key}`} hint={f.secret && savedKey ? `Saved: ${savedKey}. Leave empty to keep it.` : f.hint}>
            <Input id={`${c.type}-${f.key}`} type={f.secret ? "password" : "text"} mono autoComplete="off" value={valueOf(f)} placeholder={f.secret && savedKey ? "Keep the saved key" : f.placeholder}
              onChange={(e) => { setDraft((d) => ({ ...d, [f.key]: e.target.value })); setCheck(null); }} aria-invalid={!!bad} className={cx(bad && "border-red/60")} />
            {bad && <p className="text-xs text-red">{check!.message}</p>}
          </Field>
        );
      })}
      {c.type === "signal" ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <div><div className="text-sm text-ink">Mode</div><div className="text-xs text-ink3">{mode === "group" ? "Mercury answers in a Signal group; people join with /pair." : "Only you, in Note to Self."}</div></div>
            <Segmented value={mode} onChange={(v) => { setMode(v); setCheck(null); }} options={[{ value: "group", label: "Group" }, { value: "private", label: "Private" }]} />
          </div>
          <SignalLinker onLinked={(n) => setDraft((d) => ({ ...d, phoneNumber: n }))} />
        </>
      ) : (
        <div className="flex items-center justify-between gap-3">
          <div><div className="text-sm text-ink">Live replies</div><div className="text-xs text-ink3">Show the answer as it's written instead of all at once.</div></div>
          <Switch checked={streaming} onCheckedChange={setStreaming} />
        </div>
      )}
      {check && !(check.field && fields.some((f) => f.key === check.field)) && (
        <p className={cx("flex items-center gap-1.5 text-sm", check.ok ? "text-accent" : "text-red")}>{check.ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}{check.message}</p>
      )}
      {saved && <p className="text-sm text-ink2">{saved}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" loading={busy === "check"} onClick={() => void runCheck()}><RefreshCw size={13} /> Test</Button>
        {c.enabled || c.configured
          ? <Button size="sm" variant="primary" loading={busy === "save"} disabled={!changed} onClick={() => void save(false)}>Save</Button>
          : <Button size="sm" variant="primary" loading={busy === "save"} disabled={!changed} onClick={() => void save(true)}>Save and turn on</Button>}
        <span className="text-xs text-ink4">Credentials are tested before they're saved.</span>
      </div>
      <p className="text-xs text-ink4">{HOW_TO_JOIN[c.type]}</p>
    </div>
  );
}

function SignalLinker({ onLinked }: { onLinked: (phone: string) => void }) {
  const [state, setState] = useState<SignalLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!state || (state.status !== "waiting" && state.status !== "starting")) return;
    const t = setInterval(() => {
      void channelsApi.signalLink().then((s) => {
        setState(s);
        if (s.status === "linked" && s.phoneNumber) onLinked(s.phoneNumber);
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, [state?.status]); // eslint-disable-line react-hooks/exhaustive-deps
  async function start() {
    setError(null);
    setState({ status: "starting" });
    try { setState(await channelsApi.linkSignal()); } catch (e) { setError(errorText(e)); setState(null); }
  }
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-soft p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm text-ink2">Link this computer as a device of your Signal account.</div>
        <Button size="sm" variant="outline" loading={state?.status === "starting"} onClick={() => void start()}><QrCode size={13} /> Link a device</Button>
      </div>
      {state?.status === "starting" && <p className="text-xs text-ink3">Getting Signal's helper ready (the first time downloads it)…</p>}
      {state?.status === "waiting" && state.qrImage && (
        <div className="flex flex-col items-center gap-2 py-2">
          <img src={state.qrImage} alt="Signal link code" className="h-52 w-52 rounded-lg bg-white p-2" />
          <p className="text-center text-xs text-ink3">Signal on your phone → Settings → Linked devices → Link new device, then scan. Waiting…</p>
        </div>
      )}
      {state?.status === "linked" && <p className="flex items-center gap-1.5 text-sm text-accent"><CheckCircle2 size={14} /> Linked{state.phoneNumber ? ` to ${state.phoneNumber}` : ""}. Save to use it.</p>}
      {state?.status === "failed" && <p className="text-sm text-red">{state.error}</p>}
      {error && <p className="text-sm text-red">{error}</p>}
    </div>
  );
}

// ── People ──────────────────────────────────────────────────────────────────

function People({ c, onChange }: { c: ChannelInfo; onChange: (c: ChannelInfo) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function act(key: string, fn: () => Promise<{ channel: ChannelInfo }>) {
    setBusy(key);
    setError(null);
    try { onChange((await fn()).channel); } catch (e) { setError(errorText(e)); } finally { setBusy(null); }
  }
  const all = [...c.access.admins, ...c.access.members];
  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-ink">People</span>

      {c.access.pending.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-2xs font-medium uppercase tracking-wider text-amber">Waiting for you</span>
          {c.access.pending.map((p) => <PendingRow key={p.id} p={p} busy={busy} firstAdmin={c.access.admins.length === 0}
            onApprove={(role) => void act(`a:${p.id}`, () => channelsApi.access(c.type, "approve", p.id, role))}
            onReject={() => void act(`r:${p.id}`, () => channelsApi.access(c.type, "reject", p.id))} />)}
        </div>
      )}

      {all.length === 0 && c.access.pending.length === 0 && <p className="text-sm text-ink4">Nobody yet. {HOW_TO_JOIN[c.type]}</p>}
      {all.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line">
          {all.map((p) => <PersonRow key={p.id} p={p} busy={busy} lastAdmin={p.role === "admin" && c.access.admins.length <= 1}
            onPromote={() => void act(`p:${p.id}`, () => channelsApi.access(c.type, "promote", p.id))}
            onDemote={() => void act(`d:${p.id}`, () => channelsApi.access(c.type, "demote", p.id))}
            onRemove={() => void act(`x:${p.id}`, () => channelsApi.access(c.type, "remove", p.id))} />)}
        </div>
      )}
      {error && <p className="text-sm text-red">{error}</p>}
      {(all.length > 0 || c.access.pending.length > 0) && (
        <div><ConfirmButton size="sm" variant="ghost" confirmLabel={`Remove everyone from ${c.label}?`} onConfirm={() => void act("reset", () => channelsApi.access(c.type, "reset"))}>Reset access</ConfirmButton></div>
      )}
    </div>
  );
}

function ago(iso?: string): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return "";
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

function PendingRow({ p, busy, firstAdmin, onApprove, onReject }: { p: ChannelPending; busy: string | null; firstAdmin: boolean; onApprove: (role: "admin" | "member") => void; onReject: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber/40 bg-amber/[0.05] px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink">{p.name} {p.detail && <span className="text-ink3">{p.detail}</span>}</div>
        <div className="text-xs text-ink4">{p.code ? <>Code <span className="font-mono text-ink2">{p.code}</span> · </> : null}{ago(p.requestedAt)}</div>
      </div>
      {firstAdmin
        ? <Button size="sm" variant="primary" loading={busy === `a:${p.id}`} onClick={() => onApprove("admin")}><UserCheck size={13} /> Approve as admin</Button>
        : (
          <>
            <Button size="sm" variant="primary" loading={busy === `a:${p.id}`} onClick={() => onApprove("member")}><UserCheck size={13} /> Approve</Button>
            <Button size="sm" variant="ghost" onClick={() => onApprove("admin")}>as admin</Button>
          </>
        )}
      <Button size="sm" variant="ghost" loading={busy === `r:${p.id}`} onClick={onReject}><UserX size={13} /> Deny</Button>
    </div>
  );
}

function PersonRow({ p, busy, lastAdmin, onPromote, onDemote, onRemove }: { p: ChannelPerson; busy: string | null; lastAdmin: boolean; onPromote: () => void; onDemote: () => void; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-line px-3 py-2 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm text-ink">{p.name} {p.detail && <span className="text-ink3">{p.detail}</span>}<Badge tone={p.role === "admin" ? "accent" : "neutral"}>{p.role}</Badge></div>
        {p.since && <div className="text-xs text-ink4">since {new Date(p.since).toLocaleDateString()}</div>}
      </div>
      {p.role === "member"
        ? <Button size="sm" variant="ghost" loading={busy === `p:${p.id}`} onClick={onPromote}>Make admin</Button>
        : <Button size="sm" variant="ghost" loading={busy === `d:${p.id}`} disabled={lastAdmin} title={lastAdmin ? "The channel needs at least one admin" : undefined} onClick={onDemote}>Make member</Button>}
      <ConfirmButton size="sm" variant="ghost" confirmLabel="Remove?" disabled={lastAdmin} title={lastAdmin ? "Make someone else admin first" : undefined} onConfirm={onRemove}><UserMinus size={13} /></ConfirmButton>
    </div>
  );
}
