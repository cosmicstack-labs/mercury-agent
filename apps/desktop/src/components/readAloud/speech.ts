import { create } from "zustand";
import { ApiError } from "~/api/client";
import { speakApi } from "~/api/models";

/**
 * Read a reply aloud with Mercury's speech service. One reply at a time
 * across the app: starting another stops the first.
 *
 * The reply is turned into plain speakable text (code, tables and link
 * addresses aren't read out), split into parts at sentence boundaries, and
 * each part is fetched while the one before plays, so the first words come
 * quickly even for a long answer.
 */

export type ReadPhase = "loading" | "playing" | "needs-setup" | "error";

interface ReadAloudState {
  /** The message being read (or that needs attention), and how it's going. */
  id: string | null;
  phase: ReadPhase | null;
  error: string | null;
  play(id: string, markdown: string): void;
  stop(): void;
  dismiss(): void;
}

/** Each part stays well under the runtime's 4000-character limit; small first parts start sooner. */
const FIRST_PART = 280;
const PART = 1500;

/** Markdown → what a person would say out loud. */
export function speakableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, "\n(code omitted)\n")
    .replace(/^[ \t]*\|?[ \t]*:?-{3,}[-|: \t]*\n?/gm, "")
    .replace(/^[ \t]*\|.*\|[ \t]*$/gm, (row) => row.split("|").map((c) => c.trim()).filter(Boolean).join(", ") + ".")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<?https?:\/\/[^\s>)]*[^\s>).,;:!?'"]>?/g, "a link")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gm, "$1.")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]+/gm, "")
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^[ \t]*(?:---|\*\*\*|___)[ \t]*$/gm, "")
    .replace(/<\/?[a-z][^>]*>/gi, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\.(\s*\.)+/g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split into parts at paragraph, then sentence, then word boundaries. */
export function speechParts(text: string, first = FIRST_PART, size = PART): string[] {
  const sentences = text.split(/(?<=[.!?…:;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  const limit = () => (parts.length === 0 ? first : size);
  const push = () => { if (current) parts.push(current); current = ""; };
  for (let sentence of sentences) {
    while (sentence.length > size) {
      // One very long sentence: cut at a word boundary.
      push();
      const cut = sentence.lastIndexOf(" ", size) > size / 2 ? sentence.lastIndexOf(" ", size) : size;
      parts.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (current && current.length + 1 + sentence.length > limit()) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return parts;
}

let session: { abort: AbortController; audio: HTMLAudioElement | null; urls: string[] } | null = null;

function teardown() {
  if (!session) return;
  session.abort.abort();
  session.audio?.pause();
  session.urls.forEach((u) => URL.revokeObjectURL(u));
  session = null;
}

function playBlob(blob: Blob, s: NonNullable<typeof session>): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    s.urls.push(url);
    const audio = new Audio(url);
    s.audio = audio;
    const done = () => { s.abort.signal.removeEventListener("abort", done); resolve(); };
    audio.onended = done;
    audio.onerror = () => reject(new Error("This audio couldn't be played."));
    s.abort.signal.addEventListener("abort", done);
    audio.play().catch(reject);
  });
}

export const useReadAloud = create<ReadAloudState>((set) => ({
  id: null,
  phase: null,
  error: null,
  stop: () => { teardown(); set({ id: null, phase: null, error: null }); },
  dismiss: () => set({ id: null, phase: null, error: null }),
  play: (id, markdown) => {
    teardown();
    const parts = speechParts(speakableText(markdown));
    if (!parts.length) return;
    const s = { abort: new AbortController(), audio: null, urls: [] as string[] };
    session = s;
    const mine = () => session === s;
    set({ id, phase: "loading", error: null });
    void (async () => {
      try {
        let next: Promise<Blob> = speakApi.audio(parts[0], s.abort.signal);
        for (let i = 0; i < parts.length; i++) {
          const blob = await next;
          if (!mine()) return;
          // Fetch the next part while this one plays.
          if (i + 1 < parts.length) {
            next = speakApi.audio(parts[i + 1], s.abort.signal);
            next.catch(() => {}); // handled when awaited
          }
          set({ phase: "playing" });
          await playBlob(blob, s);
          if (!mine()) return;
        }
        if (mine()) { teardown(); set({ id: null, phase: null }); }
      } catch (err) {
        if (!mine()) return;
        teardown();
        if (err instanceof ApiError && err.data.needs === "speech") set({ id, phase: "needs-setup", error: null });
        else if (err instanceof ApiError && err.status === 404) set({ id, phase: "error", error: "This Mercury can't read aloud yet. Update Mercury to use it." });
        else set({ id, phase: "error", error: err instanceof Error ? err.message : String(err) });
      }
    })();
  },
}));
