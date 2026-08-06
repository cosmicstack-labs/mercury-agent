import { useRef, useCallback, useEffect, useState } from "react";

interface AutoScrollResult {
  containerRef: React.RefObject<HTMLDivElement>;
  isAtBottom: boolean;
  scrollToBottom: (smooth?: boolean) => void;
}

const BOTTOM_THRESHOLD = 40;

export function useAutoScroll(deps: unknown[] = []): AutoScrollResult {
  const containerRef = useRef<HTMLDivElement>(null!);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const checkBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
    setIsAtBottom(atBottom);
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Attach scroll listener
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    el.addEventListener("scroll", checkBottom, { passive: true });
    return () => el.removeEventListener("scroll", checkBottom);
  }, [checkBottom]);

  // Auto-scroll when deps change
  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { containerRef, isAtBottom, scrollToBottom };
}
