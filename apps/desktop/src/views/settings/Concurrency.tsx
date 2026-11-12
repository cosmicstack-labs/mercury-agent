import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import { ApiError } from "~/api/client";
import type { TurnsInfo } from "~/api/types";
import { refreshPulse } from "~/app/pulse";
import { Segmented, Spinner } from "~/components/ui/bits";

/**
 * Chats at once (ADR-037): how many chats Mercury works on together. Each
 * chat still handles its own messages one after another; this is how many
 * different chats run side by side. Automatic picks a limit from the
 * machine's memory (2 on Termux and small machines). Applies at once.
 */
const CHOICES = ["0", "1", "2", "3", "4", "6", "8"] as const;

export function ConcurrencySettings() {
  const [info, setInfo] = useState<TurnsInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.chat.running()
      .then(setInfo)
      .catch((e) => setError(e instanceof ApiError && (e.status === 404 || e.status === 503)
        ? "This Mercury runs one chat at a time. Update it to work on several chats together."
        : e instanceof Error ? e.message : String(e)));
  }, []);

  async function choose(value: string) {
    setSaving(true);
    setError(null);
    try {
      setInfo(await api.chat.setConcurrency(Number(value)));
      void refreshPulse.turns();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!info) return error ? <p className="text-sm text-ink3">{error}</p> : <div className="py-10 text-ink3"><Spinner size={18} /></div>;
  const current = CHOICES.find((c) => Number(c) === info.configured) ?? ("" as (typeof CHOICES)[number]);
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-ink3">
        Mercury works on several chats at the same time: a long task in one chat doesn't make the others wait. Each chat still handles its own messages in order.
      </p>
      {error && <p className="text-sm text-red" role="alert">{error}</p>}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium text-ink">Chats at once</h3>
        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface px-4 py-3">
          <Segmented value={current} onChange={(v) => void choose(v)}
            options={CHOICES.map((c) => ({ value: c, label: c === "0" ? `Auto (${info.auto})` : c }))} />
          <p className="text-xs text-ink3">
            {info.configured === 0 ? `Automatic: ${info.auto} on this computer, from its memory.` : `Set to ${info.configured}.`}
            {" "}When memory runs short, new chats wait for a free slot even below the limit. 1 means one chat at a time.
            {saving && " Saving…"}
          </p>
          <p className="font-mono text-xs text-ink3">
            Now: {info.running.length} working · {info.waiting.reduce((n, w) => n + w.waiting, 0)} waiting · limit {info.limit}
          </p>
        </div>
      </section>
    </div>
  );
}
