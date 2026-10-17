import { useState, useCallback, useEffect, useMemo } from "react";
import { Brain, Check, ChevronDown, Loader2, Pencil, RotateCcw, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import api from "@/lib/api";
import type { ModelsResponse, ReasoningChoice } from "@/lib/api";
import { useChatStore } from "@/stores/chat";

interface ModelSwitcherProps {
  currentProvider: string;
  currentModel: string;
}

type ModelEntry = ModelsResponse["providers"][number];

const REASONING_COPY: Record<ReasoningChoice, { title: string; hint: string }> = {
  auto: { title: "Auto", hint: "Let the model decide (its default)" },
  off: { title: "Off", hint: "Fastest: answers without thinking first" },
  low: { title: "Light", hint: "A quick think: good for simple tasks" },
  medium: { title: "Balanced", hint: "A good mix of speed and depth" },
  high: { title: "Deep", hint: "Thinks hardest: slower, best for tricky work" },
};

const keyOf = (p: { name: string; model: string }) => `${p.name}::${p.model}`;

export function ModelSwitcher({ currentProvider, currentModel }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const setProvider = useChatStore((s) => s.setProvider);
  const setModel = useChatStore((s) => s.setModel);

  const loadModels = useCallback(async () => {
    // Always refetch: model lists and names change (pulls, renames).
    setLoading(!models);
    try {
      setModels(await api.chat.models.list());
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, [models]);

  // Load once up front so the button can show the friendly name.
  useEffect(() => {
    loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentProvider, currentModel]);

  async function handleSwitch(entry: ModelEntry) {
    setSwitching(keyOf(entry));
    try {
      const res = await api.chat.models.switch(entry.name, entry.model);
      if (!res.ok) return;
      const data = await api.chat.models.list();
      setModels(data);
      setProvider(data.current?.name || entry.name);
      setModel(data.current?.model || entry.model);
      setOpen(false);
    } catch {
      // silently fail
    } finally {
      setSwitching(null);
    }
  }

  function startEditing(entry: ModelEntry) {
    setEditing(keyOf(entry));
    setDraft(entry.customLabel ?? entry.label);
  }

  async function saveLabel(entry: ModelEntry, label: string | null) {
    setSaving(true);
    try {
      await api.chat.models.setPrefs(entry.name, entry.model, { label });
      setModels(await api.chat.models.list());
      setEditing(null);
      // The new name may no longer match the search; show the full list.
      setQuery("");
    } catch {
      // keep the editor open so nothing typed is lost
    } finally {
      setSaving(false);
    }
  }

  async function setReasoning(choice: ReasoningChoice) {
    if (!models) return;
    const { name, model } = models.current;
    try {
      await api.chat.models.setPrefs(name, model, { reasoning: choice });
      setModels(await api.chat.models.list());
      setReasoningOpen(false);
    } catch {
      // silently fail
    }
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, ModelEntry[]>();
    for (const p of models?.providers ?? []) {
      if (q && ![p.label, p.model, p.group].some((s) => s.toLowerCase().includes(q))) continue;
      const list = map.get(p.group) ?? [];
      list.push(p);
      map.set(p.group, list);
    }
    // The current model's group first, then local before cloud-hosted ones.
    const rank = (group: string) =>
      group === models?.current.group ? 0 : /cloud/i.test(group) ? 2 : 1;
    return [...map.entries()].sort(([a], [b]) => rank(a) - rank(b));
  }, [models, query]);

  const current = models?.current;
  const displayName = current?.label || currentModel || currentProvider || "Model";
  const reasoningLevels = current?.reasoningLevels ?? [];
  const reasoning = current?.reasoning ?? "auto";
  const isLocalOllama = current?.name === "ollamaLocal" || current?.name === "ollamaCloud";

  return (
    <div className="flex items-center gap-1">
      <Popover
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (o) loadModels();
          else {
            setEditing(null);
            setQuery("");
          }
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
            title={current ? `${current.group} · ${current.model}` : undefined}
          >
            <span className="max-w-[180px] truncate">{displayName}</span>
            <ChevronDown className="h-3 w-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-2">
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models..."
              className="h-8 pl-7 text-xs"
            />
          </div>

          {loading && !models ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            </div>
          ) : groups.length ? (
            <div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
              {groups.map(([group, entries]) => (
                <div key={group}>
                  <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {entries.map((p) => {
                      const key = keyOf(p);
                      const isActive = p.name === currentProvider && p.model === currentModel;
                      const isSwitching = switching === key;

                      if (editing === key) {
                        return (
                          <div key={key} className="flex items-center gap-1 rounded-md bg-muted/60 px-2 py-1.5">
                            <Input
                              autoFocus
                              value={draft}
                              maxLength={80}
                              onChange={(e) => setDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") saveLabel(p, draft);
                                if (e.key === "Escape") setEditing(null);
                              }}
                              className="h-7 text-xs"
                              aria-label={`New name for ${p.model}`}
                            />
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={saving}
                              onClick={() => saveLabel(p, draft)} title="Save name">
                              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                            </Button>
                            {p.customLabel && (
                              <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" disabled={saving}
                                onClick={() => saveLabel(p, null)} title={`Reset to "${p.autoLabel}"`}>
                                <RotateCcw className="h-3.5 w-3.5" />
                              </Button>
                            )}
                            <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0"
                              onClick={() => setEditing(null)} title="Cancel">
                              <X className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        );
                      }

                      return (
                        <div
                          key={key}
                          className={cn(
                            "group flex items-center gap-1 rounded-md transition-colors",
                            p.available ? "hover:bg-muted/60" : "opacity-40",
                            isActive && "bg-primary/10",
                          )}
                        >
                          <button
                            disabled={!p.available || isSwitching}
                            onClick={() => {
                              if (!isActive && p.available) handleSwitch(p);
                            }}
                            className="min-w-0 flex-1 px-2 py-1.5 text-left text-sm"
                          >
                            <div className="flex items-center gap-1.5">
                              <span className="truncate font-medium text-foreground">{p.label}</span>
                              {isActive && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
                              {isSwitching && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />}
                            </div>
                            {p.hint && (
                              <p className="truncate text-[11px] text-muted-foreground" title={p.hint}>{p.hint}</p>
                            )}
                            <p className="truncate font-mono text-[10px] text-muted-foreground">{p.model}</p>
                          </button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="mr-1 h-7 w-7 shrink-0 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100"
                            onClick={() => startEditing(p)}
                            title="Rename"
                            aria-label={`Rename ${p.label}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-2 py-4 text-center text-sm text-muted-foreground">
              {query ? "No models match your search" : "No providers found"}
            </p>
          )}
        </PopoverContent>
      </Popover>

      {reasoningLevels.length > 0 && (
        <Popover open={reasoningOpen} onOpenChange={setReasoningOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
              title="How hard the model thinks before answering"
            >
              <Brain className="h-3.5 w-3.5" />
              <span>{REASONING_COPY[reasoning].title}</span>
              <ChevronDown className="h-3 w-3" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            <p className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Reasoning · {displayName}
            </p>
            <div className="flex flex-col gap-0.5">
              {(["auto", ...reasoningLevels] as ReasoningChoice[]).map((choice) => (
                <button
                  key={choice}
                  onClick={() => setReasoning(choice)}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60",
                    reasoning === choice && "bg-primary/10",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">{REASONING_COPY[choice].title}</div>
                    <div className="text-xs text-muted-foreground">{REASONING_COPY[choice].hint}</div>
                  </div>
                  {reasoning === choice && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />}
                </button>
              ))}
            </div>
            {isLocalOllama && (
              <p className="px-2 pt-2 text-[11px] text-muted-foreground">
                Most local models only switch thinking on or off. Light, Balanced and Deep differ
                on models that support levels, like GPT-OSS.
              </p>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
