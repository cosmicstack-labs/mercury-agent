import { useCallback, useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Blocks,
  Loader2,
  CheckCircle2,
  XCircle,
  RefreshCw,
  ArrowUpCircle,
  Undo2,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  Globe,
  KeyRound,
  Wrench,
  TerminalSquare,
  LifeBuoy,
  Search,
  Cpu,
  Boxes,
  Link2,
  Unlink,
  AlertTriangle,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import api, { type PluginChannelStatus, type PluginItem, type PluginSetting } from "@/lib/api";

/* ── Helpers ────────────────────────────────────────────────── */

interface Toast {
  id: number;
  type: "success" | "error";
  message: string;
}

function ToastBar({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 40 }}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur-sm",
              t.type === "success"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                : "border-destructive/30 bg-destructive/10 text-destructive"
            )}
          >
            {t.type === "success" ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            {t.message}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

function size(bytes?: number): string {
  if (!bytes) return "";
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

const STATUS: Record<PluginItem["status"], { label: string; variant: "success" | "warning" | "secondary" | "destructive" | "outline" }> = {
  enabled: { label: "Enabled", variant: "success" },
  disabled: { label: "Disabled", variant: "secondary" },
  "update-available": { label: "Update available", variant: "warning" },
  available: { label: "Available", variant: "outline" },
  installed: { label: "Installed", variant: "secondary" },
  incompatible: { label: "Incompatible", variant: "destructive" },
  error: { label: "Not running", variant: "destructive" },
};

function statusNote(p: PluginItem): string | null {
  if (p.status === "incompatible") return p.incompatibleReason ?? null;
  if (p.status === "error") return p.lastError ?? "Enabled but not running.";
  if (p.disabled && p.disabled.code !== "user") return `Turned off automatically: ${p.disabled.message}`;
  return null;
}

/* ── Page ───────────────────────────────────────────────────── */

export function PluginsPage() {
  const [items, setItems] = useState<PluginItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [safeMode, setSafeMode] = useState(false);
  const [catalogError, setCatalogError] = useState<string | undefined>();
  const [tab, setTab] = useState<"installed" | "browse">("installed");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [source, setSource] = useState("");
  const [confirmInstall, setConfirmInstall] = useState<string | null>(null);
  const [details, setDetails] = useState<PluginItem | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const toast = useCallback((type: Toast["type"], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const res = await api.plugins.list(refresh);
      setItems(res.items);
      setSafeMode(res.safeMode);
      setCatalogError(res.catalogError);
    } catch (err) {
      toast("error", errorText(err, "Could not load plugins"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [toast]);

  useEffect(() => { void load(); }, [load]);

  const installed = useMemo(() => items.filter((i) => i.installedVersion), [items]);
  const available = useMemo(() => items.filter((i) => !i.installedVersion), [items]);
  const shown = useMemo(() => {
    const list = tab === "installed" ? installed : available;
    const q = query.trim().toLowerCase();
    return q ? list.filter((i) => `${i.id} ${i.name} ${i.description}`.toLowerCase().includes(q)) : list;
  }, [tab, installed, available, query]);

  async function act(id: string, label: string, fn: () => Promise<unknown>) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await fn();
      toast("success", label);
      await load();
      if (details?.id === id) {
        const fresh = await api.plugins.info(id).catch(() => null);
        setDetails(fresh?.plugin ?? null);
      }
    } catch (err) {
      toast("error", errorText(err, "That didn't work"));
    } finally {
      setBusy((b) => ({ ...b, [id]: false }));
    }
  }

  async function install(src: string) {
    setConfirmInstall(null);
    setBusy((b) => ({ ...b, [src]: true }));
    try {
      const r = await api.plugins.install(src);
      toast("success", r.unchanged ? `${r.name} ${r.version} is already installed` : `Installed ${r.name} ${r.version}`);
      setSource("");
      setTab("installed");
      await load();
    } catch (err) {
      toast("error", errorText(err, "Install failed"));
    } finally {
      setBusy((b) => ({ ...b, [src]: false }));
    }
  }

  async function openDetails(id: string) {
    try {
      const r = await api.plugins.info(id);
      setDetails(r.plugin);
    } catch (err) {
      toast("error", errorText(err, "Could not load plugin"));
    }
  }

  const fromCatalog = confirmInstall ? available.find((i) => i.id === confirmInstall) : undefined;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#00d4ff]/10">
            <Blocks className="h-5 w-5 text-[#00d4ff]" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-foreground">Plugins</h1>
            <p className="text-sm text-muted-foreground">Add only what you use. Each plugin can be turned off or removed at any time.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => load(true)} disabled={refreshing}>
          <RefreshCw className={cn("h-4 w-4", refreshing && "animate-spin")} />
          Refresh
        </Button>
      </div>

      {safeMode && (
        <Card className="border-amber-500/30 bg-amber-500/5">
          <CardContent className="flex items-start gap-3 p-4 text-sm">
            <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium text-foreground">Safe mode: every plugin is off for this run.</p>
              <p className="text-muted-foreground">Restart Mercury without <code>--safe-mode</code> (or <code>MERCURY_PLUGINS=off</code>) to turn them back on. You can still uninstall here.</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Install from source */}
      <Card>
        <CardContent className="space-y-2 p-4 sm:p-5">
          <form
            className="flex flex-col gap-3 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              if (source.trim()) setConfirmInstall(source.trim());
            }}
          >
            <Input
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Plugin id, folder, .tgz, https URL or github:owner/repo"
              className="flex-1 font-mono text-sm"
              disabled={!!busy[source.trim()]}
            />
            <Button type="submit" disabled={!source.trim() || !!busy[source.trim()]}>
              {busy[source.trim()] ? <><Loader2 className="h-4 w-4 animate-spin" />Installing</> : "Install"}
            </Button>
          </form>
          <p className="text-xs text-muted-foreground">
            Plugins can only be installed or changed from the computer Mercury runs on.
          </p>
        </CardContent>
      </Card>

      {/* Tabs + search */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="inline-flex rounded-lg border border-border p-1">
          {([
            ["installed", `Installed (${installed.length})`],
            ["browse", `Browse (${available.length})`],
          ] as const).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                tab === key ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search plugins" className="pl-8" />
        </div>
      </div>

      {catalogError && tab === "browse" && (
        <p className="text-sm text-muted-foreground">Catalog unavailable: {catalogError}</p>
      )}

      {/* List */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-muted" />)}
        </div>
      ) : shown.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center py-14 text-center">
            <Boxes className="mb-3 h-8 w-8 text-muted-foreground" />
            <p className="font-medium text-foreground">
              {query ? "No plugins match your search." : tab === "installed" ? "No plugins installed yet." : "Nothing new in the catalog right now."}
            </p>
            {tab === "installed" && !query && (
              <Button variant="link" onClick={() => setTab("browse")}>Browse the catalog</Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((p) => {
            const s = STATUS[p.status];
            const note = statusNote(p);
            const isBusy = !!busy[p.id];
            return (
              <Card key={p.id} className="h-full">
                <CardContent className="flex h-full flex-col gap-3 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button type="button" onClick={() => openDetails(p.id)} className="truncate text-left text-sm font-semibold text-foreground hover:underline">
                        {p.name}
                      </button>
                      <p className="font-mono text-xs text-muted-foreground">
                        {p.id} · {p.installedVersion ?? p.latestVersion}
                        {p.status === "update-available" && p.latestVersion ? ` → ${p.latestVersion}` : ""}
                      </p>
                    </div>
                    {p.installedVersion ? (
                      <Switch
                        checked={p.enabled}
                        disabled={isBusy || safeMode || (p.status === "incompatible" && !p.enabled)}
                        onCheckedChange={(on) =>
                          act(p.id, on ? `Enabled ${p.name}` : `Disabled ${p.name}`, () => (on ? api.plugins.enable(p.id) : api.plugins.disable(p.id)))
                        }
                        aria-label={p.enabled ? `Disable ${p.name}` : `Enable ${p.name}`}
                      />
                    ) : null}
                  </div>
                  <p className="line-clamp-3 text-sm text-muted-foreground">{p.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant={s.variant}>{s.label}</Badge>
                    <Badge variant="outline" className="capitalize">{p.tier}</Badge>
                    {p.kind === "out-of-process" && <Badge variant="outline">Own process</Badge>}
                    {p.tools.length > 0 && <Badge variant="outline">{p.tools.length} tool{p.tools.length === 1 ? "" : "s"}</Badge>}
                    {size(p.sizeBytes) && <Badge variant="outline">{size(p.sizeBytes)}</Badge>}
                  </div>
                  {note && <p className="text-xs text-destructive">{note}</p>}
                  <div className="mt-auto flex flex-wrap gap-2 pt-1">
                    {!p.installedVersion ? (
                      <Button size="sm" disabled={isBusy || p.status === "incompatible"} onClick={() => setConfirmInstall(p.id)}>
                        {busy[p.id] ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                        Install
                      </Button>
                    ) : p.status === "update-available" ? (
                      <Button size="sm" disabled={isBusy} onClick={() => act(p.id, `Updated ${p.name}`, () => api.plugins.update(p.id))}>
                        {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUpCircle className="h-4 w-4" />}
                        Update
                      </Button>
                    ) : null}
                    <Button size="sm" variant="outline" onClick={() => openDetails(p.id)}>Details</Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Install confirmation */}
      <AlertDialog open={!!confirmInstall} onOpenChange={(o) => !o && setConfirmInstall(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Install {fromCatalog?.name ?? confirmInstall}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                {fromCatalog ? (
                  <>
                    <p>{fromCatalog.description}</p>
                    <PermissionList p={fromCatalog} />
                    <p className="flex items-center gap-1.5 text-emerald-500"><ShieldCheck className="h-4 w-4" /> From the {fromCatalog.tier} catalog, checksum verified on download.</p>
                  </>
                ) : (
                  <p className="flex items-start gap-1.5 text-amber-500">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    This isn't from the catalog, so Mercury can't verify it. Only install plugins from sources you trust: an in-process plugin runs inside Mercury with your permissions.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmInstall && install(confirmInstall)}>Install</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Details */}
      <Dialog open={!!details} onOpenChange={(o) => !o && setDetails(null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          {details && (
            <PluginDetails
              p={details}
              busy={!!busy[details.id]}
              safeMode={safeMode}
              onAct={act}
              onInstall={() => setConfirmInstall(details.id)}
              onClose={() => setDetails(null)}
            />
          )}
        </DialogContent>
      </Dialog>

      <ToastBar toasts={toasts} />
    </div>
  );
}

/* ── Details dialog ─────────────────────────────────────────── */

function PermissionList({ p }: { p: PluginItem }) {
  const network = p.permissions?.network ?? [];
  const secrets = p.permissions?.secrets ?? [];
  return (
    <ul className="space-y-1.5 text-sm">
      <li className="flex items-start gap-2"><Cpu className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />{p.kind === "out-of-process" ? "Runs in its own process: a crash can't affect Mercury" : "Runs inside Mercury"}</li>
      <li className="flex items-start gap-2"><Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />Network: {network.length ? network.join(", ") : "none"}</li>
      <li className="flex items-start gap-2"><KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />Secrets it can read: {secrets.length ? secrets.join(", ") : "none"}</li>
      {p.tools.length > 0 && <li className="flex items-start gap-2"><Wrench className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" /><span className="break-all">Tools: {p.tools.join(", ")}</span></li>}
      {p.commands.length > 0 && <li className="flex items-start gap-2"><TerminalSquare className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />Commands: {p.commands.join(", ")}</li>}
    </ul>
  );
}

function SettingField({ s, disabled, onSave }: { s: PluginSetting; disabled: boolean; onSave: (v: unknown) => void }) {
  const [draft, setDraft] = useState(s.value === undefined || s.type === "secret" ? "" : String(s.value));
  useEffect(() => setDraft(s.value === undefined || s.type === "secret" ? "" : String(s.value)), [s.value, s.type]);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <label className="text-sm font-medium text-foreground" htmlFor={`setting-${s.key}`}>
          {s.label ?? s.key}
          {s.required && (s.type === "secret" ? !s.isSet : s.value === undefined || s.value === "") && <span className="ml-2 text-xs text-amber-500">needed</span>}
          {s.type === "secret" && s.isSet && <span className="ml-2 text-xs text-emerald-500">set ✓</span>}
        </label>
        {s.type === "boolean" && (
          <Switch id={`setting-${s.key}`} checked={s.value === true} disabled={disabled} onCheckedChange={(v) => onSave(v)} />
        )}
      </div>
      {s.description && <p className="text-xs text-muted-foreground">{s.description}</p>}
      {s.type === "secret" ? (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) { onSave(draft.trim()); setDraft(""); } }}>
          <Input id={`setting-${s.key}`} value={draft} onChange={(e) => setDraft(e.target.value)} type="password" autoComplete="off" placeholder={s.isSet ? "Saved ✓ (paste to replace)" : "Paste API key"} disabled={disabled} className="h-8 text-sm" />
          <Button size="sm" variant="outline" type="submit" disabled={disabled || !draft.trim()}>Save</Button>
          {s.isSet && <Button size="sm" variant="ghost" type="button" disabled={disabled} onClick={() => onSave("")}>Remove</Button>}
        </form>
      ) : s.type === "enum" ? (
        <select
          id={`setting-${s.key}`}
          className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
          value={String(s.value ?? "")}
          disabled={disabled}
          onChange={(e) => onSave(e.target.value)}
        >
          {(s.options ?? []).map((o) => <option key={o} value={o}>{s.optionLabels?.[o] ?? o}</option>)}
        </select>
      ) : s.type !== "boolean" ? (
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); onSave(s.type === "number" ? Number(draft) : draft); }}>
          <Input id={`setting-${s.key}`} value={draft} onChange={(e) => setDraft(e.target.value)} type={s.type === "number" ? "number" : s.format === "phone" ? "tel" : "text"} placeholder={s.format === "phone" ? "+15551234567" : undefined} disabled={disabled} className="h-8 text-sm" />
          <Button size="sm" variant="outline" type="submit" disabled={disabled || draft === String(s.value ?? "")}>Save</Button>
        </form>
      ) : null}
    </div>
  );
}

function PluginDetails({ p, busy, safeMode, onAct, onInstall, onClose }: {
  p: PluginItem;
  busy: boolean;
  safeMode: boolean;
  onAct: (id: string, label: string, fn: () => Promise<unknown>) => Promise<void>;
  onInstall: () => void;
  onClose: () => void;
}) {
  const [purge, setPurge] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const s = STATUS[p.status];
  const note = statusNote(p);
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">{p.name}<Badge variant={s.variant}>{s.label}</Badge></DialogTitle>
        <DialogDescription>{p.description}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 text-sm">
        <p className="font-mono text-xs text-muted-foreground">
          {p.id} · {p.installedVersion ? `installed ${p.installedVersion}` : `latest ${p.latestVersion}`}
          {p.installedVersion && p.latestVersion && p.latestVersion !== p.installedVersion ? ` · catalog ${p.latestVersion}` : ""}
          {" · "}{p.tier === "local" ? "local source (unverified)" : `${p.tier} catalog${p.verified ? ", verified" : ""}`}
        </p>
        {note && <p className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-xs text-destructive">{note}</p>}
        <PermissionList p={p} />
        {(p.missing ?? []).map((m) => (
          <p key={m.key} className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" />
            <span><strong>{m.unlocks}</strong> needs {m.needs}. {m.fix}</span>
          </p>
        ))}
        {p.channel && p.installedVersion && <ChannelPanel id={p.id} enabled={p.enabled} />}
        {(p.settingGroups ?? []).map((g) => (
          <div key={g.id} className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">{g.label}</p>
              <Badge variant={g.ready ? "success" : "warning"}>{g.ready ? "Ready" : "Set up"}</Badge>
            </div>
            {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
            {(p.settings ?? []).filter((x) => x.group === g.id && settingApplies(x, p.settings ?? [])).map((setting) => (
              <SettingField
                key={setting.key}
                s={setting}
                disabled={busy}
                onSave={(v) => onAct(p.id, `Saved ${setting.label ?? setting.key}`, () => api.plugins.setSetting(p.id, setting.key, v))}
              />
            ))}
          </div>
        ))}
        {p.settings && p.settings.some((x) => !x.group) && (
          <div className="space-y-3 rounded-lg border border-border p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Settings</p>
            {[...p.settings].filter((x) => !x.group && settingApplies(x, p.settings ?? [])).sort((a, b) => Number(!!b.setup) - Number(!!a.setup)).map((setting) => (
              <SettingField
                key={setting.key}
                s={setting}
                disabled={busy}
                onSave={(v) => onAct(p.id, `Saved ${setting.key}`, () => api.plugins.setSetting(p.id, setting.key, v))}
              />
            ))}
          </div>
        )}
      </div>
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        {p.installedVersion ? (
          <>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => onAct(p.id, `Rolled back ${p.name}`, () => api.plugins.rollback(p.id))}>
                <Undo2 className="h-4 w-4" />Roll back
              </Button>
              <Button size="sm" variant="outline" className="text-destructive" disabled={busy} onClick={() => setConfirmRemove(true)}>
                <Trash2 className="h-4 w-4" />Uninstall
              </Button>
            </div>
            <Button
              size="sm"
              disabled={busy || safeMode}
              onClick={() => onAct(p.id, p.enabled ? `Disabled ${p.name}` : `Enabled ${p.name}`, () => (p.enabled ? api.plugins.disable(p.id) : api.plugins.enable(p.id)))}
            >
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {p.enabled ? "Disable" : "Enable"}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={busy || p.status === "incompatible"} onClick={onInstall}>Install</Button>
        )}
      </DialogFooter>

      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {p.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its code is removed and its tools disappear right away. {purge ? "Its data and settings are deleted too." : "Its data and settings are kept, so reinstalling picks up where it left off."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
            Also delete its data and settings
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                void onAct(p.id, `Uninstalled ${p.name}`, () => api.plugins.uninstall(p.id, purge)).then(onClose);
              }}
            >
              Uninstall
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/* ── Channel plugins (e.g. WhatsApp): link, status, unlink ───── */

const CHANNEL_STATE: Record<string, string> = {
  connected: "Linked",
  "needs-pairing": "Not linked yet",
  pairing: "Waiting for you to link",
  starting: "Starting…",
  disconnected: "Reconnecting…",
  "logged-out": "Logged out",
  error: "Error",
};

function ChannelPanel({ id, enabled }: { id: string; enabled: boolean }) {
  const [status, setStatus] = useState<PluginChannelStatus | null>(null);
  const [linking, setLinking] = useState(false);
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api.plugins.channel(id);
      setStatus(r.status);
      return r.status;
    } catch (err) {
      setError(errorText(err, "Couldn't read the connection status"));
      return null;
    }
  }, [id]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);

  // While linking, poll so the QR refreshes and "Linked" shows up by itself.
  useEffect(() => {
    if (!linking) return;
    const t = setInterval(async () => {
      const s = await refresh();
      if (s?.state === "connected" || s?.state === "error") setLinking(false);
    }, 2000);
    const stop = setTimeout(() => setLinking(false), 3 * 60_000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, [linking, refresh]);

  async function pair(method: "qr" | "code") {
    setError(null);
    try {
      const r = await api.plugins.pair(id, method, method === "code" ? phone : undefined);
      setStatus(r.status);
      setLinking(r.status.state !== "connected");
      if (method === "qr") await refresh();
    } catch (err) {
      setError(errorText(err, "Couldn't start linking"));
    }
  }

  async function unlink() {
    if (!window.confirm("Log Mercury out of this account? You can link it again any time.")) return;
    setError(null);
    try {
      await api.plugins.unlink(id);
      await refresh();
    } catch (err) {
      setError(errorText(err, "Couldn't unlink"));
    }
  }

  if (!enabled) return <p className="text-xs text-muted-foreground">Enable the plugin to link an account.</p>;
  const state = status?.state ?? "starting";
  const connected = state === "connected";
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Account</p>
        <Badge variant={connected ? "success" : state === "error" || state === "logged-out" ? "destructive" : "secondary"}>
          {CHANNEL_STATE[state] ?? state}
        </Badge>
      </div>
      {status?.account && <p className="text-sm">Linked as <span className="font-mono">+{status.account}</span></p>}
      {status?.detail && !connected && <p className="text-xs text-muted-foreground">{status.detail}</p>}
      {linking && status?.qrImage && (
        <div className="flex flex-col items-center gap-2">
          <img src={status.qrImage} alt="Scan this QR code with the phone you are linking" className="h-56 w-56 rounded-md bg-white p-2" />
          <p className="text-center text-xs text-muted-foreground">On the spare phone: WhatsApp → Settings → Linked devices → Link a device, then scan. It refreshes every ~20 seconds.</p>
        </div>
      )}
      {linking && status?.pairCode && (
        <div className="text-center">
          <p className="font-mono text-2xl tracking-widest">{status.pairCode}</p>
          <p className="text-xs text-muted-foreground">On the spare phone: Linked devices → Link a device → Link with phone number instead, then type this code.</p>
        </div>
      )}
      {!connected && (
        <div className="space-y-2">
          <Button size="sm" onClick={() => pair("qr")} className="w-full">
            <Link2 className="h-4 w-4" />Link with QR code
          </Button>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) void pair("code"); }}>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Or the spare number, e.g. +15550001111" className="h-8 text-sm" />
            <Button size="sm" variant="outline" type="submit" disabled={!phone.trim()}>Get code</Button>
          </form>
          <p className="text-xs text-amber-600 dark:text-amber-400">Unofficial protocol: link a spare number you can afford to lose, not your main one.</p>
        </div>
      )}
      {connected && (
        <Button size="sm" variant="outline" onClick={unlink}>
          <Unlink className="h-4 w-4" />Unlink
        </Button>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/** Hide settings that only apply to other choices (manifest `when`). */
function settingApplies(s: PluginSetting, all: PluginSetting[]): boolean {
  if (!s.when) return true;
  const values = Object.fromEntries(all.map((x) => [x.key, x.value]));
  const conds = Array.isArray(s.when) ? s.when : [s.when];
  return conds.some((cond) => Object.entries(cond).every(([key, want]) =>
    Array.isArray(want) ? want.includes(String(values[key])) : String(values[key]) === String(want)));
}
