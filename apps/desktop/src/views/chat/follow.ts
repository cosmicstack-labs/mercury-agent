import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * Follow the bottom of a streaming conversation, and stop the moment the
 * reader scrolls up (wheel, trackpad, keys, scrollbar), the way ChatGPT and
 * Codex do. Following again: back at the bottom, Jump, or sending a message.
 *
 * Decided by what the reader does, not by where the view is: a token every
 * few milliseconds would otherwise pull a small scroll back down before it
 * counted.
 */

/** Close enough to the bottom to count as "at the bottom". */
const AT_BOTTOM_PX = 24;

export interface Follow {
  following: boolean;
  /** Scroll to the newest and follow again. */
  jump: (smooth?: boolean) => void;
  onScroll: () => void;
}

export function useFollowBottom(scroller: RefObject<HTMLDivElement | null>, content: RefObject<HTMLDivElement | null>, resetKey: unknown): Follow {
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(true);
  /** Where we last put scrollTop ourselves, so our own scrolls aren't read as the reader's. */
  const ours = useRef<number | null>(null);
  /** A smooth jump is on its way down: its scrolls aren't the reader's. */
  const jumping = useRef(false);

  const set = useCallback((v: boolean) => {
    if (followingRef.current === v) return;
    followingRef.current = v;
    setFollowing(v);
  }, []);

  const pin = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const top = el.scrollHeight - el.clientHeight;
    if (Math.abs(el.scrollTop - top) < 1) return;
    ours.current = top;
    el.scrollTop = top;
  }, [scroller]);

  const jump = useCallback((smooth = true) => {
    const el = scroller.current;
    set(true);
    if (!el) return;
    if (smooth) {
      ours.current = null;
      jumping.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    } else pin();
  }, [scroller, set, pin]);

  // A new conversation opens at its newest message.
  useEffect(() => { set(true); requestAnimationFrame(pin); }, [resetKey, set, pin]);

  // Anything that grows the conversation (tokens, tool output, images
  // loading, an approval) keeps it pinned while following.
  useEffect(() => {
    const el = content.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (followingRef.current) pin(); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [content, pin, resetKey]);

  // The reader moving up lets go at once.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const up = () => { jumping.current = false; if (el.scrollHeight > el.clientHeight) set(false); };
    const onWheel = (e: WheelEvent) => { if (e.deltaY < 0) up(); };
    let touchY: number | null = null;
    const onTouchStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? null; };
    const onTouchMove = (e: TouchEvent) => { const y = e.touches[0]?.clientY; if (touchY !== null && y !== undefined && y > touchY + 4) up(); };
    const onKey = (e: KeyboardEvent) => {
      // Only keys aimed at the conversation, not at the composer.
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (["ArrowUp", "PageUp", "Home"].includes(e.key) || (e.key === " " && e.shiftKey)) up();
    };
    el.addEventListener("wheel", onWheel, { passive: true });
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: true });
    el.addEventListener("keydown", onKey);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("keydown", onKey);
    };
  }, [scroller, set]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (ours.current !== null && Math.abs(el.scrollTop - ours.current) < 2) { ours.current = null; return; }
    if (fromBottom <= AT_BOTTOM_PX) { jumping.current = false; set(true); return; }
    if (jumping.current) return;
    // Dragging the scrollbar sends no wheel or key: any other scroll away from the bottom is the reader's.
    if (fromBottom > AT_BOTTOM_PX * 4) set(false);
  }, [scroller, set]);

  return { following, jump, onScroll };
}

/** What the jump pill says while the reader is up the page. */
export function jumpLabel({ busy, unseen, finished }: { busy: boolean; unseen: number; finished: boolean }): string {
  if (unseen > 0) return `${unseen} new message${unseen === 1 ? "" : "s"}`;
  if (busy) return "Mercury is writing";
  if (finished) return "Reply finished";
  return "Jump to latest";
}
