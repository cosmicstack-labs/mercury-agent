import { CheckCircle2, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import * as api from "~/api/mercury";
import { ApiError } from "~/api/client";
import type { PairRefusal, PairShown, PairStatus, PairedPhone } from "~/api/types";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Mono, Spinner } from "~/components/ui/bits";
import { errorText } from "./Models";

export type PairView =
  | { kind: "loading" }
  | { kind: "showing"; pair: PairShown }
  | { kind: "refused"; reason: PairRefusal; message: string }
  | { kind: "paired"; device: PairedPhone }
  | { kind: "ended"; status: "expired" | "replaced" | "cancelled" }
  | { kind: "error"; message: string };

const REFUSALS: readonly PairRefusal[] = ["remote-off", "limit", "not-running", "none", "insecure", "loopback", "invalid"];

export function canPairHere(kind: string, features: readonly string[] | undefined): boolean {
  return kind === "local" && !!features?.includes("auth.pairCode");
}

export function refusedView(e: unknown): PairView {
  if (e instanceof ApiError && e.status === 409) {
    const reason = e.data.reason as PairRefusal;
    if (REFUSALS.includes(reason)) return { kind: "refused", reason, message: String(e.data.message ?? e.message) };
  }
  return { kind: "error", message: errorText(e) };
}

export function statusView(s: PairStatus): PairView | null {
  if (s.status === "waiting") return null;
  if (s.status === "paired") return { kind: "paired", device: s.device };
  return { kind: "ended", status: s.status };
}

export function asksForAddress(reason: PairRefusal): boolean {
  return reason === "none" || reason === "insecure" || reason === "loopback" || reason === "invalid";
}

export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

const ENDED: Record<"expired" | "replaced" | "cancelled", string> = {
  expired: "The code expired before a phone used it.",
  replaced: "A newer code replaced this one.",
  cancelled: "The code was cancelled.",
};

export function PairPhone({ onPaired, onClose, initialAddress }: { onPaired: () => void; onClose: () => void; initialAddress?: string }) {
  const [view, setView] = useState<PairView>({ kind: "loading" });
  const [address, setAddress] = useState(initialAddress ?? "");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const run = useRef(0);
  const live = useRef<string | null>(null);

  async function start(addr?: string) {
    const mine = ++run.current;
    setBusy(true);
    try {
      const pair = await api.security.pair(addr);
      if (mine !== run.current) return;
      live.current = pair.id;
      setNow(Date.now());
      setView({ kind: "showing", pair });
    } catch (e) {
      if (mine === run.current) setView(refusedView(e));
    } finally {
      if (mine === run.current) setBusy(false);
    }
  }

  async function turnOn() {
    setBusy(true);
    try {
      await api.security.setRemote({ enabled: true });
      await start(address.trim() || undefined);
    } catch (e) {
      setView({ kind: "error", message: errorText(e) });
      setBusy(false);
    }
  }

  useEffect(() => {
    void start(initialAddress);
    return () => {
      run.current++;
      if (live.current) {
        live.current = null;
        void api.security.cancelPair().catch(() => {});
      }
    };
  }, []);

  const showingId = view.kind === "showing" ? view.pair.id : null;

  useEffect(() => {
    if (!showingId) return;
    let stop = false;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    void (async () => {
      while (!stop) {
        try {
          const next = statusView(await api.security.pairStatus(showingId));
          if (stop) return;
          if (next) {
            live.current = null;
            setView(next);
            if (next.kind === "paired") onPaired();
            return;
          }
        } catch (e) {
          if (!stop) setView({ kind: "error", message: errorText(e) });
          return;
        }
      }
    })();
    return () => { stop = true; clearInterval(tick); };
  }, [showingId]);

  if (view.kind === "loading") {
    return <p className="flex items-center gap-2 py-6 text-sm text-ink3"><Spinner /> Making a code…</p>;
  }

  if (view.kind === "showing") {
    const p = view.pair;
    return (
      <div className="flex flex-col items-center gap-3">
        <img src={p.qrImage} alt="Pairing code" className="h-52 w-52 rounded-lg bg-white p-2" />
        <p className="text-center text-xs text-ink3">In the Mercury app on your phone: Connect → Scan to connect. Or type the address and code.</p>
        <div className="w-full rounded-lg border border-line bg-surface px-4 py-3 text-sm">
          <div className="flex items-center justify-between gap-3"><span className="text-ink3">Address</span><Mono className="truncate">{p.address}</Mono></div>
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-ink3">Code</span>
            <span className="flex items-center gap-1">
              <Mono>{p.display}</Mono>
              <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(p.display).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}><Copy size={13} /> {copied ? "Copied" : "Copy"}</Button>
            </span>
          </div>
        </div>
        <p className="text-xs text-ink4">Works once · {minutesLeft(p.expiresAt, now)} min left · waiting for your phone…</p>
        <div className="flex w-full justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    );
  }

  if (view.kind === "paired") {
    return (
      <div className="flex flex-col gap-4">
        <p className="flex items-center gap-2 text-sm text-accent"><CheckCircle2 size={16} /> Paired with {view.device.name}{view.device.platform && view.device.platform !== "unknown" ? ` (${view.device.platform})` : ""}</p>
        <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    );
  }

  if (view.kind === "ended") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-ink2">{ENDED[view.status]}</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          <Button variant="primary" loading={busy} onClick={() => void start(address.trim() || undefined)}>Make a new code</Button>
        </div>
      </div>
    );
  }

  if (view.kind === "refused") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-ink2">{view.message}</p>
        {asksForAddress(view.reason) && (
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (address.trim()) void start(address.trim()); }}>
            <Input mono value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://mercury.example.com" aria-label="Address your phone opens Mercury at" />
            <Button type="submit" variant="primary" loading={busy} disabled={!address.trim()}>Use it</Button>
          </form>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {view.reason === "remote-off" && <Button variant="primary" loading={busy} onClick={() => void turnOn()}>Turn remote access on</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-red">{view.message}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary" loading={busy} onClick={() => void start(address.trim() || undefined)}>Try again</Button>
      </div>
    </div>
  );
}
