import { useState, type FormEvent } from "react";
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
export function AddRemote({ onAdded }: { onAdded: () => void }) {
  const [mode, setMode] = useState<"password" | "token">("password");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("mercury");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const add = useConnections((s) => s.add);
  const setActive = useConnections((s) => s.setActive);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const baseUrl = normalizeBaseUrl(url);
    if (!/^https?:\/\//i.test(baseUrl)) { setError("Enter the runtime's address, starting with http:// or https://"); return; }
    setBusy(true);
    try {
      const platform = await desktop.platform();
      const host = await desktop.hostname();
      let credential: string;
      let deviceId: string | undefined;
      if (mode === "password") {
        const paired = await api.auth.pair(baseUrl, username.trim(), password, `${host} · Mercury Desktop`, platform);
        credential = paired.token;
        deviceId = paired.device.id;
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
    }
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
        <Field label="Device token" htmlFor="remote-token" hint="Made on that machine with: mercury devices add">
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
