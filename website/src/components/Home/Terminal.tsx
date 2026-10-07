import React, { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import type { TermLine } from './data';

const STEP_MS = 240;

/**
 * Terminal — a replay of real Mercury output.
 *
 * Every line is rendered as plain text on the server, so the demos are
 * indexable and readable with JS off. On the client the lines are hidden only
 * once we know an animation will actually run (in view, motion allowed), then
 * revealed one by one. `syncGlyph` drives the hero glyph's working/complete
 * state through the window.mercuryGlyph bus exposed by KillipiGlyph.
 */
export default function Terminal({
  lines,
  title,
  syncGlyph = false,
  className,
}: {
  lines: TermLine[];
  title: string;
  syncGlyph?: boolean;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'static' | 'armed' | 'playing'>('static');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    setPhase('armed');
    const timers: number[] = [];
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        obs.disconnect();
        setPhase('playing');
        if (!syncGlyph) return;
        const bus = (window as any).mercuryGlyph;
        const total = lines.length * STEP_MS;
        bus?.working?.__holdUntil?.(Date.now() + total);
        bus?.working?.();
        timers.push(window.setTimeout(() => (window as any).mercuryGlyph?.complete?.(), total + 200));
      },
      { threshold: 0.35 },
    );
    obs.observe(el);
    return () => {
      obs.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [lines, syncGlyph]);

  return (
    <figure className={clsx('mx-term', `mx-term--${phase}`, className)} ref={ref}>
      <div className="mx-term__bar" aria-hidden="true">
        <span /><span /><span />
        <em>{title}</em>
      </div>
      <div className="mx-term__body">
        {lines.map((l, i) => (
          <div key={i} className={`mx-tl mx-tl--${l.k}`} style={{ '--i': i } as React.CSSProperties}>
            <span className="mx-tl__mark" aria-hidden="true">{MARKS[l.k]}</span>
            <span className="mx-tl__text">{l.t}</span>
            {l.n && <span className="mx-tl__note">{l.n}</span>}
          </div>
        ))}
        <span className="mx-term__cursor" aria-hidden="true" />
      </div>
    </figure>
  );
}

const MARKS: Record<TermLine['k'], string> = {
  cmd: '$',
  in: '›',
  ok: '✓',
  dim: '',
  ask: '?',
  opt: ' ',
  sel: '❯',
  done: '■',
  mem: '◆',
  say: '☿',
  warn: '!',
  gap: '',
};
