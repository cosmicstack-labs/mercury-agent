import { useState, type FormEvent } from "react";
import * as api from "~/api/mercury";
import { ApiError, normalizeBaseUrl } from "~/api/client";
import { Button } from "~/components/ui/Button";
import { Field, Input } from "~/components/ui/Input";
import { newConnectionId, useConnections } from "./connections";

/**
 * Pair with a runtime that is not on this computer: paste a device token
 * made there (`/server token <name>`, `mercury devices add`). Mercury has
 * no password sign-in; the token is kept in the OS keychain.
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
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Plain http to another machine sends the token readable on the way: warn once.
  const [httpOk, setHttpOk] = useState(false);
  const add = useConnections((s) => s.add);
  const setActive = useConnections((s) => s.setActive);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const baseUrl = normalizeBaseUrl(url);
    if (!/^https?:\/\//i.test(baseUrl)) { setError("Enter the runtime's address, starting with http:// or https://"); return; }
    if (insecureRemote(baseUrl) && !httpOk) {
      setError("This address isn't https, so your token would cross the network unencrypted. Use the https address of your tunnel (Tailscale, Cloudflare), or press Connect again to continue anyway.");
      setHttpOk(true);
      return;
    }
    setBusy(true);
    try {
      const credential = token.trim();
      if (!/^mdt_[0-9a-f]{8}_[0-9a-f]{64}$/.test(credential)) throw new Error("That does not look like a device token (mdt_…).");
      const health = await api.health.probe(baseUrl, credential);
      if (!health.ok) throw new Error("The runtime answered, but not with a healthy status.");
      const deviceId = credential.split("_")[1];
      const id = newConnectionId();
      await add({ id, kind: "remote", name: name.trim() || new URL(baseUrl).host, baseUrl, deviceId }, credential);
      await setActive(id);
      setToken("");
      onAdded();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429 && err.retryAfterSeconds) setError(`Too many attempts. Try again in ${Math.ceil(err.retryAfterSeconds / 60)} min.`);
      else if (err instanceof TypeError) setError("Could not reach that address. Check the URL and that the runtime is reachable from here (tunnel, VPN, or a public host).");
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <Field label="Address" htmlFor="remote-url">
        <Input id="remote-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mercury.tail1234.ts.net" mono />
      </Field>
      <Field label="Device token" htmlFor="remote-token" hint="Make one on that machine: /server token <name>  (or mercury devices add <name>)">
        <Input id="remote-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" mono />
      </Field>
      <Field label="Name (optional)" htmlFor="remote-name"><Input id="remote-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Home server" /></Field>
      {error && <div className="rounded-md border border-red/30 bg-red/[0.06] px-2.5 py-1.5 text-xs text-red">{error}</div>}
      <div className="mt-1 flex gap-2">
        <Button type="submit" variant="primary" size="lg" className="flex-1" loading={busy}>Connect</Button>
        <Button type="button" variant="outline" size="lg" disabled title="QR pairing arrives with the phone app">Scan QR</Button>
      </div>
    </form>
  );
}
