import { useRef, useState, type FormEvent } from "react";
import { KeyRound } from "lucide-react";
import * as api from "~/api/mercury";
import { ApiError, normalizeBaseUrl } from "~/api/client";
import { Button } from "~/components/ui/Button";
import { Field, Input } from "~/components/ui/Input";
import { Segmented } from "~/components/ui/bits";
import { desktop } from "./tauri";
import { newConnectionId, useConnections } from "./connections";

/**
 * Pair with a runtime that is not on this computer: sign in with the
 * dashboard password (the runtime mints a device token for this app), or
 * paste a token made there with `mercury devices add`. Only the token is
 * kept, in the OS keychain.
 */
/** Another machine over plain http (a tailnet address is encrypted by the VPN itself). */
export function insecureRemote(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "http:") return false;
    const h = u.hostname;
    if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]") return false;
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) || h.endsWith(".ts.net")) return false;
    return true;
  } catch {
    return false;
  }
}

export function AddRemote({ onAdded }: { onAdded: () => void }) {
  const [mode, setMode] = useState<"password" | "token">("password");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("mercury");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Pairing from here waits for the runtime's owner to approve this device.
  const [waiting, setWaiting] = useState<{ code: string; where: string } | null>(null);
  const cancel = useRef<AbortController | null>(null);
  // Plain http to another machine sends the password readable on the way: warn once.
  const [httpOk, setHttpOk] = useState(false);
  const add = useConnections((s) => s.add);
  const setActive = useConnections((s) => s.setActive);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const baseUrl = normalizeBaseUrl(url);
    if (!/^https?:\/\//i.test(baseUrl)) { setError("Enter the runtime's address, starting with http:// or https://"); return; }
    if (insecureRemote(baseUrl) && !httpOk) {
      setError("This address isn't https, so your password and token would cross the network unencrypted. Use the https address of your tunnel (Tailscale, Cloudflare), or press Connect again to continue anyway.");
      setHttpOk(true);
      return;
    }
    setBusy(true);
    try {
      const platform = await desktop.platform();
      const host = await desktop.hostname();
      let credential: string;
      let deviceId: string | undefined;
      if (mode === "password") {
        const paired = await api.auth.pair(baseUrl, username.trim(), password, `${host} · Mercury Desktop`, platform);
        if ("pending" in paired) {
          // The owner approves this device on their channel or that computer.
          setWaiting({ code: paired.code, where: paired.where });
          const ac = new AbortController();
          cancel.current = ac;
          let approved: { token: string; device: { id: string } } | null = null;
          while (!ac.signal.aborted && Date.now() < paired.expiresAt + 5_000) {
            const r = await api.auth.pollPair(baseUrl, paired.pairingId, paired.pollToken, ac.signal).catch((e) => (ac.signal.aborted ? null : { status: "pending" as const, error: String(e) }));
            if (!r || ac.signal.aborted) break;
            if (r.status === "approved" && r.token && r.device) { approved = { token: r.token, device: r.device }; break; }
            if (r.status === "denied" || r.status === "expired" || r.status === "error") throw new Error(r.error || (r.status === "denied" ? "The owner didn't approve this device." : "Nobody approved this device in time. Connect again to ask again."));
          }
          setWaiting(null);
          if (!approved) { if (!ac.signal.aborted) throw new Error("Nobody approved this device in time. Connect again to ask again."); return; }
          credential = approved.token;
          deviceId = approved.device.id;
        } else {
          credential = paired.token;
          deviceId = paired.device.id;
        }
      } else {
        credential = token.trim();
        if (!/^mdt_[0-9a-f]{8}_[0-9a-f]{64}$/.test(credential)) throw new Error("That does not look like a device token (mdt_…).");
        const health = await api.health.probe(baseUrl, credential);
        if (!health.ok) throw new Error("The runtime answered, but not with a healthy status.");
        deviceId = credential.split("_")[1];
      }
      const id = newConnectionId();
      await add({ id, kind: "remote", name: name.trim() || new URL(baseUrl).host, baseUrl, deviceId }, credential);
      await setActive(id);
      setPassword("");
      setToken("");
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && err.retryAfterSeconds) setError(`Too many attempts. Try again in ${Math.ceil(err.retryAfterSeconds / 60)} min.`);
      else if (err instanceof TypeError) setError("Could not reach that address. Check the URL and that the runtime is reachable from here (tunnel, VPN, or a public host).");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setWaiting(null);
      cancel.current = null;
    }
  }

  if (waiting) {
    return (
      <div className="flex flex-col gap-3" role="status">
        <div className="flex items-start gap-3 rounded-lg border border-line bg-soft p-3.5">
          <KeyRound size={18} className="mt-0.5 shrink-0 text-amber" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink">Waiting for the owner to approve this device</p>
            <p className="mt-1 text-sm text-ink2">Approve it on {waiting.where}.</p>
            <p className="mt-2 text-xs text-ink3">Code</p>
            <p className="font-mono text-2xl font-semibold tracking-[0.2em] text-ink">{waiting.code}</p>
            <p className="mt-2 text-xs text-ink4">On Telegram or WhatsApp, reply “approve {waiting.code}”. On that computer: /server approve {waiting.code}, or the prompt in Mercury Desktop.</p>
          </div>
        </div>
        <Button variant="outline" size="lg" onClick={() => cancel.current?.abort()}>Cancel</Button>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <Field label="Address" htmlFor="remote-url">
        <Input id="remote-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mercury.tail1234.ts.net" mono />
      </Field>
      <Segmented value={mode} onChange={setMode} options={[{ value: "password", label: "Sign in" }, { value: "token", label: "Device token" }]} />
      {mode === "password" ? (
        <>
          <Field label="Username" htmlFor="remote-user"><Input id="remote-user" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" /></Field>
          <Field label="Password" htmlFor="remote-pass"><Input id="remote-pass" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
        </>
      ) : (
        <Field label="Device token" htmlFor="remote-token" hint="Made on that machine with: /server token <name>  (or mercury devices add)">
          <Input id="remote-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" mono />
        </Field>
      )}
      <Field label="Name (optional)" htmlFor="remote-name"><Input id="remote-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home server" /></Field>
      {error && <div className="rounded-md border border-red/30 bg-red/[0.06] px-2.5 py-1.5 text-xs text-red">{error}</div>}
      <div className="mt-1 flex gap-2">
        <Button type="submit" variant="primary" size="lg" className="flex-1" loading={busy}>Connect</Button>
        <Button type="button" variant="outline" size="lg" disabled title="QR pairing arrives with the phone app">Scan QR</Button>
      </div>
    </form>
  );
}
