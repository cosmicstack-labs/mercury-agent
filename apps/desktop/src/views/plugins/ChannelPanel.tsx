import { CheckCircle2, Link2, QrCode, Smartphone, Unlink } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { http } from "~/api/client";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Badge, Spinner } from "~/components/ui/bits";
import { ConfirmButton } from "~/components/ui/kit";

/**
 * Link a messaging plugin (WhatsApp) to an account: scan the live QR code
 * with the phone, or get a pairing code for a number instead. Then test it,
 * or unlink. Polls the plugin while it's open, so the QR stays fresh and
 * "linked" shows the moment the phone approves.
 */

interface ChannelStatus { state: string; detail?: string; account?: string; qr?: string; qrImage?: string; pairCode?: string; at: number }

const enc = encodeURIComponent;
const channelApi = {
  status: (id: string) => http.get<{ status: ChannelStatus | null }>(`/api/plugins/${enc(id)}/channel`),
  pair: (id: string, method: "qr" | "code", phone?: string) => http.post<{ status: ChannelStatus }>(`/api/plugins/${enc(id)}/pair`, { method, phone }),
  test: (id: string) => http.post<{ message: string }>(`/api/plugins/${enc(id)}/test`),
  unlink: (id: string) => http.post<{ ok: boolean }>(`/api/plugins/${enc(id)}/unlink`),
};

function linked(s: ChannelStatus | null): boolean {
  return !!s && (s.state === "connected" || s.state === "ready" || s.state === "linked");
}

export function ChannelPanel({ id, name }: { id: string; name: string }) {
  const [status, setStatus] = useState<ChannelStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<"qr" | "code">("qr");

  const load = useCallback(async () => {
    try { setStatus((await channelApi.status(id)).status); setError(null); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [load]);

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setNote(null);
    try { await fn(); if (done) setNote(done); await load(); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  }

  const isLinked = linked(status);
  const waiting = !!status && (status.qr || status.pairCode) && !isLinked;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-soft px-3 py-2.5 text-sm">
        {isLinked ? <CheckCircle2 size={15} className="text-accent" /> : <Smartphone size={15} className="text-ink3" />}
        <span className="min-w-0 flex-1 text-ink2">
          {status ? (isLinked ? <>Linked{status.account ? <> to <span className="font-mono text-ink">{status.account}</span></> : ""}.</> : status.detail ?? status.state) : "Checking…"}
        </span>
        {status && <Badge tone={isLinked ? "accent" : "amber"}>{status.state}</Badge>}
      </div>
      {error && <p className="text-sm text-red">{error}</p>}

      {!isLinked && (
        <>
          <div className="flex gap-2">
            <Button size="sm" variant={method === "qr" ? "secondary" : "ghost"} onClick={() => setMethod("qr")}><QrCode size={13} /> QR code</Button>
            <Button size="sm" variant={method === "code" ? "secondary" : "ghost"} onClick={() => setMethod("code")}><Link2 size={13} /> Code for a number</Button>
          </div>
          {method === "qr" ? (
            <div className="flex flex-col items-center gap-3">
              {status?.qrImage
                ? <img src={status.qrImage} alt={`${name} QR code`} className="h-56 w-56 rounded-lg bg-white p-2" />
                : <Button variant="primary" loading={busy === "qr"} onClick={() => void run("qr", () => channelApi.pair(id, "qr"))}>Show QR code</Button>}
              {status?.qrImage && <p className="text-center text-xs text-ink3">On the phone {name} runs on: {name} → Settings → Linked devices → Link a device, then scan. The code refreshes by itself.</p>}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+92 300 1234567" mono aria-label="Phone number" />
                <Button variant="primary" loading={busy === "code"} disabled={!/^\+?[\d\s-]{6,20}$/.test(phone.trim())} onClick={() => void run("code", () => channelApi.pair(id, "code", phone.trim()))}>Get code</Button>
              </div>
              {status?.pairCode && (
                <div className="flex flex-col items-center gap-1 py-2">
                  <span className="rounded-md bg-ink/[0.06] px-4 py-2 font-mono text-xl tracking-[0.3em] text-ink">{status.pairCode}</span>
                  <span className="text-xs text-ink3">{name} → Linked devices → Link a device → Link with phone number instead, then type this code.</span>
                </div>
              )}
            </div>
          )}
          {waiting && <p className="flex items-center justify-center gap-2 text-xs text-ink3"><Spinner size={11} /> Waiting for the phone…</p>}
        </>
      )}

      {isLinked && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" loading={busy === "test"} onClick={() => void run("test", async () => setNote((await channelApi.test(id)).message))}>Send a test message</Button>
          <ConfirmButton size="sm" variant="ghost" confirmLabel="Unlink this account?" onConfirm={() => void run("unlink", () => channelApi.unlink(id), "Unlinked.")}><Unlink size={13} /> Unlink</ConfirmButton>
        </div>
      )}
      {note && <p className="text-sm text-ink2">{note}</p>}
    </div>
  );
}
