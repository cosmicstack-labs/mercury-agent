import { useEffect, useState } from "react";
import * as api from "~/api/mercury";
import type { BotApproval } from "~/api/types";
import { refreshApprovals } from "~/app/events";
import { useBots } from "~/app/store";
import { NeedsYou, type NeedsYouItem } from "~/components/needs-you/NeedsYou";
import { describePrompt } from "~/components/needs-you/describe";

/** Bot questions as Needs-you items: plain words, Allow once / Always allow / Deny, how long it waits. */
export function botQuestionItems(approvals: BotApproval[], now = Date.now()): NeedsYouItem[] {
  return approvals.map((a) => ({
    id: a.id,
    described: describePrompt({ kind: "permission", text: a.prompt }),
    from: `${a.botName} · waits ${Math.max(0, Math.ceil((a.expiresAt - now) / 60_000))} min, then it's a no`,
    // After reading something untrusted there is nothing to "always" allow: once, or no.
    options: /^(⚠ Possible prompt injection|Mercury read content from outside)/.test(a.prompt)
      ? [{ value: "yes", label: "Allow once", role: "primary" }, { value: "no", label: "Deny", role: "quiet" }]
      : [
        { value: "yes", label: "Allow once", role: "primary" },
        { value: "always", label: `Always allow for ${a.botName}`, role: "secondary" },
        { value: "no", label: "Deny", role: "quiet" },
      ],
    onAnswer: async (v: string | null) => { await api.bots.answer(a.id, (v ?? "no") as "yes" | "always" | "no").catch(() => {}); void refreshApprovals(); },
  }));
}

/** Every question waiting right now (for some bots, or all of them), one at a time. */
export function PendingApprovals({ botId, botIds }: { botId?: string; botIds?: string[] }) {
  const approvals = useBots((s) => s.approvals);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { void refreshApprovals(); const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  const want = botIds ?? (botId ? [botId] : null);
  const mine = approvals.filter((a) => !want || want.includes(a.botId));
  if (mine.length === 0) return null;
  return <NeedsYou items={botQuestionItems(mine, now)} />;
}
