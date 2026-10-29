import { CheckCircle2, CircleAlert, CircleDashed, ExternalLink, LogIn, LogOut, Power, RefreshCw, Sparkles, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cloudApi, type CloudSignIn, type CloudStatus } from "~/api/models";
import { useUi } from "~/app/store";
import { Button } from "~/components/ui/Button";
import { Badge, Spinner } from "~/components/ui/bits";
import { ConfirmButton } from "~/components/ui/kit";
import { desktop } from "~/shell/tauri";
import { cx } from "~/lib/cx";

/**
 * Mercury Cloud: the quick start (sign in, chat, no API keys). Always first.
 * Only says whether it's signed in and working, and signs in again from the
 * app; the model is chosen once, under "Chat and tasks".
 */

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function useCloudStatus(enabled = true): { status: CloudStatus | null; error: string | null; checking: boolean; refresh: (fresh?: boolean) => Promise<void> } {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = useCallback(async (fresh = false) => {
    setChecking(true);
    try { setStatus(await cloudApi.status(fresh)); setError(null); } catch (e) { setError(errorText(e)); } finally { setChecking(false); }
  }, []);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  return { status, error, checking, refresh };
}

export function CloudCard({ onChanged }: { onChanged: () => void }) {
  const { status, error, checking, refresh } = useCloudStatus();
  const [signingIn, setSigningIn] = useState(false);
  const [busy, setBusy] = useState<"power" | "signout" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [signedOut, setSignedOut] = useState<string | null>(null);

  async function setEnabled(enabled: boolean) {
    setBusy("power");
    setNote(null);
    try {
      await cloudApi.setEnabled(enabled);
      await refresh(true);
      onChanged();
    } catch (e) { setNote(errorText(e)); } finally { setBusy(null); }
  }

  async function signOut() {
    setBusy("signout");
    setNote(null);
    try {
      const r = await cloudApi.signOut();
      setSignedOut(r.setupNext
        ? "Signed out. Mercury is restarting and will ask you to connect a model."
        : `Signed out. Mercury is restarting${r.fallback ? " with your other provider" : ""}…`);
      // The runtime restarts; the app reconnects by itself. Refresh once it's back.
      setTimeout(() => { setSignedOut(null); void refresh(true); onChanged(); }, 7000);
    } catch (e) { setNote(errorText(e)); } finally { setBusy(null); }
  }
  const connected = !!status && status.chat.ok;
  return (
    <div className={cx("flex flex-col gap-4 rounded-xl border p-4", status?.action === "sign-in" && status.paired ? "border-amber/50 bg-amber/[0.04]" : "border-accent/40 bg-accent/[0.04]")}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/15 text-accent"><Sparkles size={18} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-medium text-ink">Mercury Cloud</span>
            <Badge tone="cyan">recommended</Badge>
            {status?.isDefault && connected && <Badge tone="accent">default</Badge>}
            {status?.tier && status.paired && <Badge>{status.tier}</Badge>}
            {status?.paired && !status.enabled && <Badge tone="amber">off</Badge>}
          </div>
          <p className="text-xs text-ink3">The quick start: sign in and chat. No API keys; models from every major lab on one account.</p>
        </div>
        <Button size="sm" variant="ghost" icon onClick={() => void refresh(true)} loading={checking} aria-label="Check Mercury Cloud now" title="Check now"><RefreshCw size={14} /></Button>
      </div>

      {signedOut && <p className="flex items-center gap-2 text-sm text-ink2"><Spinner size={13} /> {signedOut}</p>}
      {error && !signedOut && <p className="text-sm text-red">Couldn't check Mercury Cloud: {error}</p>}
      {status?.paired && !status.enabled && !signedOut && (
        <p className="text-sm text-ink3">Turned off: you're still signed in, but Mercury isn't using Cloud for chat.</p>
      )}
      {!status && !error && <Spinner size={14} />}

      {status && (status.paired || status.chat.ok) && (
        <div className="grid grid-cols-1 gap-1.5 rounded-lg border border-line bg-surface p-3 text-sm sm:grid-cols-3">
          <Check ok={status.chat.ok} label="Chat" detail={status.chat.ok ? `${status.chat.models.length} models` : status.chat.error ?? "not working"} />
          <Check ok={status.session === "online"} warn={status.session === "offline"} label="Agent connection"
            detail={status.session === "online" ? "online" : status.session === "offline" ? "reconnecting" : status.session === "signed-out" ? "signed out" : "off"} />
          <Check ok={status.selfRecovers} warn={!status.selfRecovers} label="Stays signed in"
            detail={status.selfRecovers ? "renews by itself" : "sign in again to turn on"} />
        </div>
      )}

      {status?.action === "sign-in" && status.paired && !signingIn && (
        <p className="flex items-start gap-2 text-sm text-ink2">
          <TriangleAlert size={15} className="mt-0.5 shrink-0 text-amber" />
          {status.chat.ok
            ? "Your session with Mercury Cloud expired and couldn't renew itself. Chat still works, but the agent is offline for the Cloud dashboard and phone. Sign in again to fix it for good."
            : "Mercury Cloud no longer accepts this sign-in. Sign in again to keep chatting."}
        </p>
      )}

      {signingIn ? (
        <CloudSignInFlow onDone={() => { setSigningIn(false); onChanged(); }} onCancel={() => setSigningIn(false)} />
      ) : (status?.action === "sign-in" || !status?.paired) && status ? (
        <div><Button variant="primary" onClick={() => setSigningIn(true)}><LogIn size={14} /> {status.paired ? "Sign in again" : "Sign in to Mercury Cloud"}</Button></div>
      ) : null}

      {status?.paired && !signingIn && !signedOut && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {status.enabled
            ? <Button size="sm" variant="ghost" loading={busy === "power"} onClick={() => void setEnabled(false)}><Power size={13} /> Turn off</Button>
            : <Button size="sm" variant="primary" loading={busy === "power"} onClick={() => void setEnabled(true)}><Power size={13} /> Turn on</Button>}
          <ConfirmButton size="sm" variant="ghost" confirmLabel="Sign out of Mercury Cloud?" loading={busy === "signout"} onConfirm={() => void signOut()}>
            <LogOut size={13} /> Sign out
          </ConfirmButton>
          <span className="text-xs text-ink4">Signing out forgets the Cloud sign-in on this computer. Mercury restarts.</span>
        </div>
      )}
      {note && <p className="text-sm text-red">{note}</p>}

      {status && status.chat.ok && !status.modelOk && !signingIn && (
        <p className="text-xs text-amber">The saved Mercury Cloud model ({status.model}) can't chat. Pick one under “Chat and tasks” below.</p>
      )}
    </div>
  );
}

function Check({ ok, warn, label, detail }: { ok: boolean; warn?: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-center gap-2">
      {ok ? <CheckCircle2 size={14} className="shrink-0 text-accent" /> : warn ? <CircleDashed size={14} className="shrink-0 text-amber" /> : <CircleAlert size={14} className="shrink-0 text-red" />}
      <span className="text-ink">{label}</span>
      <span className="truncate text-xs text-ink3">{detail}</span>
    </div>
  );
}

/**
 * Sign in: Mercury asks Cloud for a pairing code, the browser opens to
 * approve it, and Mercury waits. When approved, Mercury saves the new
 * session and restarts itself; the app reconnects on its own.
 */
export function CloudSignInFlow({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const [state, setState] = useState<CloudSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restarting, setRestarting] = useState(false);
  const opened = useRef(false);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    async function begin() {
      try {
        const s = await cloudApi.startSignIn();
        if (!live) return;
        setState(s);
        if (!opened.current) { opened.current = true; void desktop.openExternal(s.pairingUrl); }
        poll();
      } catch (e) { if (live) setError(errorText(e)); }
    }
    function poll() {
      timer = setTimeout(async () => {
        try {
          const s = await cloudApi.signIn();
          if (!live) return;
          if ("code" in s) {
            setState(s);
            if (s.status === "done") { setRestarting(true); setTimeout(() => { if (live) onDone(); }, 6000); return; }
            if (s.status === "failed") return;
          }
        } catch { /* Mercury may be restarting; keep waiting */ }
        if (live) poll();
      }, 1500);
    }
    void begin();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-red">{error}</p>
      {onCancel && <div><Button size="sm" variant="ghost" onClick={onCancel}>Close</Button></div>}
    </div>
  );
  if (restarting) return <p className="flex items-center gap-2 text-sm text-ink2"><Spinner size={13} /> Signed in. Mercury is restarting with the new session…</p>;
  if (!state) return <p className="flex items-center gap-2 text-sm text-ink3"><Spinner size={13} /> Starting sign-in…</p>;
  if (state.status === "failed") return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-red">{state.error}</p>
      <div className="flex gap-2">
        {state.upgradeUrl && <Button size="sm" variant="primary" onClick={() => void desktop.openExternal(state.upgradeUrl!)}>Upgrade plan <ExternalLink size={12} /></Button>}
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Close</Button>}
      </div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
      <p className="text-sm text-ink2">Approve this computer in your browser. Waiting for you…</p>
      <div className="flex items-center gap-3">
        <span className="rounded-md bg-ink/[0.06] px-3 py-1.5 font-mono text-base tracking-widest text-ink">{state.code}</span>
        <Spinner size={14} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void desktop.openExternal(state.pairingUrl)}>Open the browser again <ExternalLink size={12} /></Button>
        {onCancel && <Button size="sm" variant="ghost" onClick={() => { void cloudApi.cancelSignIn().catch(() => {}); onCancel(); }}>Cancel</Button>}
      </div>
    </div>
  );
}

/**
 * A thin bar across the app when Mercury Cloud is the default and its
 * session is gone: it says what still works and fixes it in one click.
 * Checked on start, every 10 minutes, and whenever the window comes back.
 */
export function CloudBanner({ supported }: { supported: boolean }) {
  const { status, refresh } = useCloudStatus(supported);
  const [hidden, setHidden] = useState(false);
  const openSettings = useUi((s) => s.openSettings);
  useEffect(() => {
    if (!supported) return;
    const t = setInterval(() => void refresh(), 10 * 60_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => { clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [supported, refresh]);
  if (!supported || hidden || !status || !status.paired || !status.isDefault || status.action !== "sign-in") return null;
  return (
    <div className="flex items-center gap-3 border-b border-amber/30 bg-amber/[0.08] px-4 py-1.5 text-xs text-ink2">
      <TriangleAlert size={13} className="shrink-0 text-amber" />
      <span className="min-w-0 flex-1 truncate">
        {status.chat.ok ? "Mercury Cloud signed out: chat works, but the agent is offline for the Cloud dashboard and phone." : "Mercury Cloud signed out: chat won't work until you sign in again."}
      </span>
      <Button size="sm" variant="primary" onClick={() => openSettings("models")}><LogIn size={12} /> Sign in again</Button>
      <button onClick={() => setHidden(true)} className="text-ink4 hover:text-ink" aria-label="Hide for now"><X size={13} /></button>
    </div>
  );
}
