import { Check, Copy, Plus, QrCode, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { create } from "zustand";
import * as api from "~/api/mercury";
import type { PairedDevice, SecurityStatus } from "~/api/mercury";
import { Button } from "~/components/ui/Button";
import { Dialog } from "~/components/ui/Dialog";
import { Input } from "~/components/ui/Input";
import { Switch } from "~/components/ui/Switch";
import { Spinner } from "~/components/ui/bits";
import { useHealth } from "~/app/health";
import { PairPhone } from "~/views/settings/PairPhone";

/**
 * Remote access (/server) as a window of its own: typed in the chat, it
 * opens here instead of running as a chat turn (no loader in the
 * conversation, no menu stuck in the transcript). Everything goes through
 * /api/security/*, which answers only on the computer Mercury runs on.
 */

export const useServerPanel = create<{ open: boolean; pair: string | null; show: (pair?: string | null) => void; hide: () => void; startPair: (address?: string) => void; endPair: () => void }>((set) => ({
  open: false,
  pair: null,
  show: (pair = null) => set({ open: true, pair }),
  hide: () => set({ open: false, pair: null }),
  startPair: (address = "") => set({ pair: address }),
  endPair: () => set({ pair: null }),
}));

/** The composer hands "/server …" here. */
export function isServerCommand(text: string): boolean {
  return /^\/server(\s|$)/i.test(text.trim());
}

export function pairRequest(text: string): string | null {
  const m = /^\/server\s+pair(?:\s+(\S+))?\s*$/i.exec(text.trim());
  return m ? m[1] ?? "" : null;
}

const TAILSCALE = "100.64.0.0/10";

const ago = (iso: string | null | undefined): string => {
  if (!iso) return "never used";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129_600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} days ago`;
};

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <section className="border-t border-line pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-medium text-ink">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-ink3">{hint}</p>}
      <div className="mt-2.5">{children}</div>
    </section>
  );
}

function Toggle({ id, label, detail, checked, onChange, busy }: { id: string; label: string; detail: string; checked: boolean; onChange: (v: boolean) => void; busy: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <label htmlFor={id} className="text-sm text-ink">{label}</label>
        <p className="text-xs text-ink3">{detail}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={busy} />
    </div>
  );
}

export function ServerPanel() {
  const open = useServerPanel((s) => s.open);
  const hide = useServerPanel((s) => s.hide);
  const pair = useServerPanel((s) => s.pair);
  const startPair = useServerPanel((s) => s.startPair);
  const endPair = useServerPanel((s) => s.endPair);
  const canPair = !!useHealth()?.features?.includes("auth.pairCode");
  const [status, setStatus] = useState<SecurityStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [ip, setIp] = useState("");
  const [tokenName, setTokenName] = useState("");
  const [token, setToken] = useState<{ name: string; value: string } | null>(null);
  // The runtime decides what "this computer" is (a remote connection can be a loopback one).
  const [elsewhere, setElsewhere] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.server.status()); setError(null); setElsewhere(false); }
    catch (e) {
      if ((e as { status?: number }).status === 403) { setElsewhere(true); return; }
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Fresh every time it opens; nothing lingers once it's closed (a token least of all).
  useEffect(() => {
    if (!open) { setToken(null); setNote(null); setIp(""); setTokenName(""); setStatus(null); return; }
    void load();
  }, [open, load]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setNote(null);
    setError(null);
    try { await fn(); if (done) setNote(done); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const r = status?.remote;

  function addIp(e?: FormEvent, value = ip) {
    e?.preventDefault();
    const rule = value.trim();
    if (!rule || !r) return;
    void act(async () => { await api.server.setRemote({ allowIps: [...new Set([...r.allowIps, rule])] }); setIp(""); }, `Allowed ${rule}. Only listed addresses can connect now.`);
  }

  function makeToken(e: FormEvent) {
    e.preventDefault();
    const name = tokenName.trim() || "Manual token";
    void act(async () => { const made = await api.server.createDevice(name); setToken({ name: made.device.name, value: made.token }); setTokenName(""); });
  }

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token.value);
      // Copied: the token leaves the screen, as it was the point of showing it.
      setNote(`Token for “${token.name}” copied. Paste it into the device; it isn't shown again.`);
      setToken(null);
    } catch {
      setError("Couldn't reach the clipboard: select the token and copy it, then press Done.");
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) hide(); }} title="Remote access" description="Which other devices can reach this Mercury, and how." width={560}>
      {elsewhere ? (
        <p className="text-sm text-ink2">Remote access is managed on the computer Mercury runs on: open Mercury Desktop there, or type /server in its terminal.</p>
      ) : !status ? (
        error ? <p className="text-sm text-red">{error}</p> : <div className="flex justify-center py-8"><Spinner /></div>
      ) : (
        <div className="flex flex-col gap-4">
          {(note || error) && (
            // Pinned to the top of the window: a result is seen wherever the owner scrolled to.
            <div role="status" className={`sticky top-0 z-10 rounded-md border px-2.5 py-1.5 text-xs shadow-sm ${error ? "border-red/30 bg-raised text-red" : "border-accent/40 bg-raised text-ink2"}`}>{error ?? note}</div>
          )}

          {status.pending.length > 0 && (
            <Section title={`Waiting for you (${status.pending.length})`}>
              {status.pending.map((p) => (
                <div key={p.id} className="flex items-center justify-between gap-3 py-1">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{p.title}</p>
                    <p className="text-xs text-ink3">Code {p.code}{p.ip ? ` · from ${p.ip}` : ""}</p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.security.decide(p.id, "deny"), `Denied: ${p.title}.`)}>Deny</Button>
                    <Button size="sm" variant="primary" disabled={busy} onClick={() => void act(() => api.security.decide(p.id, "allow"), `Approved: ${p.title}.`)}><ShieldCheck size={13} /> Approve</Button>
                  </div>
                </div>
              ))}
            </Section>
          )}

          <Section title="Access">
            <Toggle id="srv-remote" label="Remote access" detail={r!.enabled ? "Approved devices can connect from other computers and phones." : "Only this computer can use Mercury."} checked={r!.enabled} busy={busy}
              onChange={(v) => void act(() => api.server.setRemote({ enabled: v }), v ? "Remote access is on." : "Remote access is off: every other device is refused.")} />
            <Toggle id="srv-password" label="Password sign-in from other devices" detail={r!.passwordSignIn ? "The apps may also sign in with the username and password (you approve each new one)." : "Off: devices connect with a device token made here."} checked={r!.passwordSignIn} busy={busy}
              onChange={(v) => void act(() => api.server.setRemote({ passwordSignIn: v }), v ? "Password sign-in is on for other devices." : "Password sign-in is off: devices use a device token.")} />
            <Toggle id="srv-shell" label="Terminal for remote devices" detail={r!.allowShell ? "On: each command still asks you first." : "Off: remote devices can't run commands."} checked={r!.allowShell} busy={busy}
              onChange={(v) => void act(() => api.server.setRemote({ allowShell: v }), v ? "Remote devices may use the terminal; each command asks you." : "The terminal is off for remote devices.")} />
          </Section>

          <Section title="Allowed addresses" hint={r!.allowIps.length ? "Only these addresses can connect." : "Any address (approved devices from anywhere)."}>
            {r!.allowIps.map((rule) => (
              <div key={rule} className="flex items-center justify-between py-0.5">
                <span className="font-mono text-sm text-ink">{rule}</span>
                <Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove ${rule}`} onClick={() => void act(() => api.server.setRemote({ allowIps: r!.allowIps.filter((x) => x !== rule) }), `Removed ${rule}.`)}><X size={13} /> Remove</Button>
              </div>
            ))}
            <form className="mt-1.5 flex gap-2" onSubmit={(e) => addIp(e)}>
              <Input value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.7 or 192.168.1.0/24" mono aria-label="Address or range to allow" autoComplete="off" spellCheck={false} />
              <Button type="submit" size="md" variant="outline" disabled={busy || !ip.trim()}><Plus size={13} /> Add</Button>
            </form>
            <div className="mt-2 flex flex-wrap gap-2">
              {!r!.allowIps.includes(TAILSCALE) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => addIp(undefined, TAILSCALE)}>Add my Tailscale network</Button>}
              {status.lastRemote?.clientIpKnown && !r!.allowIps.includes(status.lastRemote.ip) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => addIp(undefined, status.lastRemote!.ip)}>Add {status.lastRemote.ip} (last remote device)</Button>}
              {r!.allowIps.length > 0 && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.server.setRemote({ allowIps: [] }), "Any address may connect again (devices still need approval).")}>Allow any address</Button>}
            </div>
            {status.lastRemote && !status.lastRemote.clientIpKnown && r!.allowIps.length > 0 && (
              <p className="mt-2 text-xs text-amber">Your tunnel doesn't pass client addresses, so this list refuses every remote device until it does.</p>
            )}
          </Section>

          <Section title={`Devices (${status.devices.length} of ${r!.maxDevices})`} hint={r!.idleDays ? `Unused devices stop working after ${r!.idleDays} days.` : "Devices never expire."}>
            {status.devices.length === 0 && <p className="text-sm text-ink3">No devices are paired.</p>}
            {status.devices.map((d: PairedDevice) => (
              <div key={d.id} className="flex items-center justify-between gap-3 py-1">
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{d.name}</p>
                  <p className="text-xs text-ink3">{d.platform} · {ago(d.lastSeenAt)}{d.lastIp ? ` · ${d.lastIp}` : ""}</p>
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.server.revokeDevice(d.id), `Signed out “${d.name}”.`)}>Sign out</Button>
              </div>
            ))}
            {canPair && !token && (
              <Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => startPair()}><QrCode size={13} /> Pair a phone with a QR code</Button>
            )}
            {token ? (
              <div className="mt-2 rounded-lg border border-accent/40 bg-soft p-3">
                <p className="text-sm font-medium text-ink">Token for “{token.name}”</p>
                <p className="mt-0.5 text-xs text-ink3">Shown only now. Paste it into the device: Connect with a device token.</p>
                <p className="mt-2 select-all break-all rounded-md bg-surface p-2 font-mono text-xs text-ink">{token.value}</p>
                <div className="mt-2 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={() => { setToken(null); setNote(`Token for “${token.name}” made.`); }}><Check size={13} /> Done</Button>
                  <Button size="sm" variant="primary" onClick={() => void copyToken()}><Copy size={13} /> Copy and close</Button>
                </div>
              </div>
            ) : (
              <form className="mt-2 flex gap-2" onSubmit={makeToken}>
                <Input value={tokenName} onChange={(e) => setTokenName(e.target.value)} placeholder="Device name, e.g. My phone" aria-label="Name of the device" autoComplete="off" />
                <Button type="submit" size="md" variant="outline" disabled={busy}>Make a token</Button>
              </form>
            )}
            {status.devices.length > 1 && (
              <Button className="mt-2" size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api.server.revokeAll(), "Signed out every device.")}>Sign out every device</Button>
            )}
          </Section>

          <Section title={`Security check: ${status.check.summary}`}>
            {status.check.findings.filter((f) => f.level !== "ok").length === 0 ? (
              <p className="flex items-center gap-1.5 text-sm text-ink2"><ShieldCheck size={14} className="text-accent" /> Nothing to fix.</p>
            ) : status.check.findings.filter((f) => f.level !== "ok").map((f, i) => (
              <div key={i} className="flex items-start gap-2 py-1">
                <ShieldAlert size={14} className={`mt-0.5 shrink-0 ${f.level === "risk" ? "text-red" : "text-amber"}`} />
                <div className="min-w-0">
                  <p className="text-sm text-ink">{f.title}</p>
                  {(f.detail || f.fix) && <p className="text-xs text-ink3">{[f.detail, f.fix].filter(Boolean).join(" ")}</p>}
                </div>
              </div>
            ))}
          </Section>
          {busy && <div className="flex justify-end"><Spinner size={12} /></div>}
        </div>
      )}
      <Dialog open={open && canPair && !elsewhere && pair !== null} onOpenChange={(o) => { if (!o) { endPair(); void load(); } }} title="Pair a phone" description="Scan the code with the Mercury app on your phone.">
        {open && canPair && !elsewhere && pair !== null && <PairPhone initialAddress={pair || undefined} onPaired={() => void load()} onClose={() => { endPair(); void load(); }} />}
      </Dialog>
    </Dialog>
  );
}
