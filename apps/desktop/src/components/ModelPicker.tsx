import { Check, ChevronsUpDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "~/lib/cx";
import { Spinner } from "~/components/ui/bits";

/**
 * A searchable menu of models. Takes every model a provider offers (hundreds
 * on a gateway), filters as you type, and still lets you use an id that
 * isn't listed ("Use “my-model”"). Arrow keys and Enter work.
 */
export function ModelPicker({ value, models, onChange, recommended, loading, disabled, placeholder = "Choose a model", id }: {
  value: string;
  models: string[];
  onChange: (model: string) => void;
  recommended?: string;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => filterModels(models, query), [models, query]);
  const custom = query.trim() && !models.includes(query.trim()) && !/\s/.test(query.trim()) ? query.trim() : null;
  const rows = custom ? [...shown, custom] : shown;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  useEffect(() => { setCursor(0); }, [query, open]);
  useEffect(() => { list.current?.querySelector<HTMLElement>(`[data-i="${cursor}"]`)?.scrollIntoView({ block: "nearest" }); }, [cursor]);

  function pick(m: string) {
    onChange(m);
    setOpen(false);
    setQuery("");
  }

  return (
    <div ref={root} className="relative">
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-9 w-full items-center gap-2 rounded-md border border-line bg-surface px-3 text-left text-sm text-ink transition-colors hover:border-ink/25 disabled:opacity-50"
      >
        <span className={cx("min-w-0 flex-1 truncate font-mono text-[12.5px]", !value && "font-sans text-sm text-ink4")}>{value || placeholder}</span>
        {value && value === recommended && <span className="shrink-0 rounded-full bg-accent/15 px-1.5 text-2xs text-accent">recommended</span>}
        {loading ? <Spinner size={12} /> : <ChevronsUpDown size={14} className="shrink-0 text-ink4" />}
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-50 overflow-hidden rounded-lg border border-line bg-surface shadow-xl">
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search size={13} className="text-ink4" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(rows.length - 1, c + 1)); }
                else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(0, c - 1)); }
                else if (e.key === "Enter") { e.preventDefault(); const r = rows[cursor]; if (r) pick(r); }
                else if (e.key === "Escape") { e.preventDefault(); setOpen(false); }
              }}
              placeholder={models.length ? `Search ${models.length} models` : "Type a model id"}
              className="h-9 flex-1 bg-transparent text-sm text-ink placeholder:text-ink4"
              aria-label="Search models"
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>
          <div ref={list} role="listbox" className="max-h-[280px] overflow-y-auto p-1">
            {rows.length === 0 && <div className="px-3 py-3 text-xs text-ink4">{loading ? "Loading models…" : "No models match."}</div>}
            {rows.map((m, i) => {
              const isCustom = m === custom && i === rows.length - 1;
              return (
                <button
                  key={`${m}-${i}`}
                  type="button"
                  data-i={i}
                  role="option"
                  aria-selected={m === value}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => pick(m)}
                  className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left", i === cursor ? "bg-ink/[0.07]" : "")}
                >
                  <Check size={13} className={cx("shrink-0 text-accent", m === value ? "opacity-100" : "opacity-0")} />
                  <span className={cx("min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink", isCustom && "font-sans text-sm text-ink2")}>{isCustom ? `Use “${m}”` : m}</span>
                  {m === recommended && !isCustom && <span className="shrink-0 text-2xs text-accent">recommended</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

/** Every word must appear (in any order); ids that start with the query rank first. */
export function filterModels(models: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  const words = q.split(/[\s/:]+/).filter(Boolean);
  const hits = models.filter((m) => { const l = m.toLowerCase(); return words.every((w) => l.includes(w)); });
  return hits.sort((a, b) => Number(!a.toLowerCase().startsWith(q)) - Number(!b.toLowerCase().startsWith(q)));
}
