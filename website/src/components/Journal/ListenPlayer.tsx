import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import './listen.css';

/**
 * "Listen to article", spoken by the reader's own browser (Web Speech API).
 * Nothing is downloaded or hosted: the voice is whatever the device offers,
 * and we pick the most natural one available (Edge's "Natural" voices,
 * Chrome's Google voices, Safari's Enhanced/Premium voices…).
 *
 * The article is read sentence by sentence. That keeps pause, seek and speed
 * changes precise, and avoids Chrome's habit of cutting off long utterances.
 * Code, tables, diagrams, charts and link previews are skipped.
 */

interface Segment {
  text: string;
  /** Block element to highlight while this sentence is spoken. */
  el: HTMLElement | null;
  /** Characters before this segment, for progress and seeking. */
  offset: number;
}

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2];
const WORDS_PER_MINUTE = 165;
const VOICE_KEY = 'mj-listen-voice';
const RATE_KEY = 'mj-listen-rate';

const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|junior|ralph|kathy|fred|grandma|grandpa|rocko|shelley|sandy|flo|eddy|reed)\b/i;

function voiceScore(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let s = 0;
  if (/^en(-|_|$)/i.test(v.lang)) s += 100; else return -1;
  if (/en[-_]us/i.test(v.lang)) s += 12;
  else if (/en[-_](gb|au|ca|ie|nz)/i.test(v.lang)) s += 8;
  if (/natural|neural/.test(name)) s += 60;
  if (/online/.test(name)) s += 20;
  if (/premium/.test(name)) s += 45;
  if (/enhanced/.test(name)) s += 35;
  if (/^google/.test(name)) s += 40;
  if (/siri/.test(name)) s += 30;
  if (/samantha|ava|allison|evan|zoe|serena|daniel|karen|moira/.test(name)) s += 10;
  if (/compact|espeak|mbrola/.test(name)) s -= 50;
  if (NOVELTY.test(name)) s -= 80;
  if (v.default) s += 2;
  return s;
}

function rankVoices(all: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  return all.filter((v) => voiceScore(v) > 0).sort((a, b) => voiceScore(b) - voiceScore(a));
}

function prettyVoice(v: SpeechSynthesisVoice): string {
  return v.name
    .replace(/^Microsoft\s+/i, '')
    .replace(/\s+Online\s+\(Natural\)/i, ' (Natural)')
    .replace(/\s+-\s+English.*$/i, '')
    .trim();
}

function store(key: string, value?: string): string | null {
  try {
    if (value === undefined) return window.localStorage.getItem(key);
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode or blocked storage */
  }
  return null;
}

const SKIP_NOTE: [string, string][] = [
  ['.theme-code-block, .mj-gh-code, pre', 'Code sample skipped.'],
  ['table, .mj-compare', 'Table skipped.'],
  ['.mj-diagram', 'Diagram skipped.'],
  ['.mj-chart, .mj-stats', 'Chart skipped.'],
];
const SILENT_SKIP = '.mj-embed, img, hr, details, .mj-tools, script, style, svg';

function cleanText(s: string): string {
  return s.replace(/[​‌‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

function splitSentences(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment: (t: string) => Iterable<{ segment: string }> } }).Segmenter;
  const parts = Seg
    ? [...new Seg('en', { granularity: 'sentence' }).segment(text)].map((p) => p.segment)
    : text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [text];
  // Very long sentences are split at commas so a pause or seek never waits long.
  return parts.flatMap((p) => (p.length > 280 ? p.split(/(?<=[,;:])\s+/) : [p])).map(cleanText).filter(Boolean);
}

/** Readable blocks of the article, in order, with skip notes for non-prose. */
function collectBlocks(root: HTMLElement): { text: string; el: HTMLElement }[] {
  const out: { text: string; el: HTMLElement }[] = [];
  const visit = (node: Element) => {
    const el = node as HTMLElement;
    for (const [selector, note] of SKIP_NOTE) {
      if (el.matches(selector)) {
        out.push({ text: note, el });
        return;
      }
    }
    if (el.matches(SILENT_SKIP)) return;
    if (el.matches('ul, ol, blockquote, .theme-admonition, div') && (el.children.length > 0 || el.matches('.theme-admonition'))) {
      // Containers: read their children so each paragraph/list item highlights on its own.
      if (el.matches('.theme-admonition')) {
        const heading = el.querySelector('[class*="admonitionHeading"]');
        if (heading) out.push({ text: cleanText(heading.textContent ?? ''), el });
        const content = el.querySelector('[class*="admonitionContent"]');
        if (content) [...content.children].forEach(visit);
        return;
      }
      [...el.children].forEach(visit);
      return;
    }
    if (el.matches('li')) {
      const clone = el.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('ul, ol, pre, .theme-code-block, figure').forEach((n) => n.remove());
      const text = cleanText(clone.textContent ?? '');
      if (text) out.push({ text, el });
      el.querySelectorAll(':scope > ul, :scope > ol').forEach(visit);
      return;
    }
    if (el.matches('figure')) return; // any other figure: decorative
    const block = node as HTMLElement;
    const text = cleanText(block.textContent ?? '');
    if (text) out.push({ text, el: block });
  };
  [...root.children].forEach(visit);
  return out;
}

function buildSegments(title: string, root: HTMLElement): Segment[] {
  const segs: Segment[] = [];
  let offset = 0;
  const push = (text: string, el: HTMLElement | null) => {
    segs.push({ text, el, offset });
    offset += text.length + 1;
  };
  push(title.endsWith('.') ? title : `${title}.`, null);
  for (const block of collectBlocks(root)) for (const s of splitSentences(block.text)) push(s, block.el);
  return segs;
}

function fmtMinutes(min: number): string {
  if (min < 1) return 'under a minute';
  return `${Math.round(min)} min`;
}

/* ── icons ─────────────────────────────────────────────────────────────── */
const I = {
  play: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" /></svg>,
  pause: <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /><rect x="13.5" y="5" width="4" height="14" rx="1.2" fill="currentColor" /></svg>,
  back: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M11 7 6 12l5 5M18 7l-5 5 5 5" /></svg>,
  fwd: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="m13 7 5 5-5 5M6 7l5 5-5 5" /></svg>,
  close: <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" d="m7 7 10 10M17 7 7 17" /></svg>,
  wave: <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="3" y="10" width="2.2" height="4" rx="1.1" /><rect x="7.2" y="7" width="2.2" height="10" rx="1.1" /><rect x="11.4" y="4" width="2.2" height="16" rx="1.1" /><rect x="15.6" y="7.5" width="2.2" height="9" rx="1.1" /><rect x="19.8" y="10" width="2.2" height="4" rx="1.1" /></g></svg>,
};

/* ── component ─────────────────────────────────────────────────────────── */

export default function ListenPlayer({ title, articleRef, minutes }: { title: string; articleRef: RefObject<HTMLElement | null>; minutes: number }): React.ReactElement | null {
  const [supported, setSupported] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [open, setOpen] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [index, setIndex] = useState(0);
  const [menu, setMenu] = useState(false);
  const [floating, setFloating] = useState(false);

  const segments = useRef<Segment[]>([]);
  const indexRef = useRef(0);
  const playingRef = useRef(false);
  const rateRef = useRef(1);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const token = useRef(0);
  const anchor = useRef<HTMLDivElement>(null);
  const activeEl = useRef<HTMLElement | null>(null);

  // Feature detection and voice discovery (voices load asynchronously in Chrome).
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return undefined;
    const synth = window.speechSynthesis;
    const load = () => {
      const ranked = rankVoices(synth.getVoices());
      if (ranked.length === 0) return;
      setVoices(ranked);
      setSupported(true);
      const saved = store(VOICE_KEY);
      const pick = ranked.find((v) => v.name === saved) ?? ranked[0];
      voiceRef.current = pick;
      setVoiceName(pick.name);
    };
    load();
    synth.addEventListener?.('voiceschanged', load);
    const savedRate = Number(store(RATE_KEY));
    if (RATES.includes(savedRate)) {
      rateRef.current = savedRate;
      setRate(savedRate);
    }
    return () => {
      synth.removeEventListener?.('voiceschanged', load);
      token.current += 1;
      synth.cancel();
    };
  }, []);

  const totalChars = useCallback(() => {
    const segs = segments.current;
    const last = segs[segs.length - 1];
    return last ? last.offset + last.text.length : 1;
  }, []);

  const highlight = useCallback((el: HTMLElement | null) => {
    if (activeEl.current === el) return;
    activeEl.current?.classList.remove('mj-listen-active');
    activeEl.current = el;
    if (!el) return;
    el.classList.add('mj-listen-active');
    const r = el.getBoundingClientRect();
    if (r.top < 90 || r.bottom > window.innerHeight - 110) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, []);

  const speakFrom = useCallback((start: number) => {
    const synth = window.speechSynthesis;
    const my = ++token.current;
    synth.cancel();
    const step = (i: number) => {
      if (my !== token.current) return;
      const segs = segments.current;
      if (i >= segs.length) {
        playingRef.current = false;
        setPlaying(false);
        indexRef.current = 0;
        setIndex(0);
        highlight(null);
        return;
      }
      indexRef.current = i;
      setIndex(i);
      highlight(segs[i].el);
      const u = new SpeechSynthesisUtterance(segs[i].text);
      if (voiceRef.current) {
        u.voice = voiceRef.current;
        u.lang = voiceRef.current.lang;
      }
      u.rate = rateRef.current;
      u.onend = () => step(i + 1);
      u.onerror = (e) => {
        // 'interrupted'/'canceled' are our own cancels; anything else, skip ahead.
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        step(i + 1);
      };
      synth.speak(u);
    };
    step(start);
  }, [highlight]);

  const ensureSegments = useCallback(() => {
    if (segments.current.length === 0 && articleRef.current) segments.current = buildSegments(title, articleRef.current);
    return segments.current.length > 0;
  }, [articleRef, title]);

  const play = useCallback(() => {
    if (!ensureSegments()) return;
    setOpen(true);
    playingRef.current = true;
    setPlaying(true);
    speakFrom(indexRef.current);
  }, [ensureSegments, speakFrom]);

  const pause = useCallback(() => {
    playingRef.current = false;
    setPlaying(false);
    token.current += 1;
    window.speechSynthesis.cancel();
  }, []);

  const stop = useCallback(() => {
    pause();
    indexRef.current = 0;
    setIndex(0);
    setOpen(false);
    setMenu(false);
    highlight(null);
  }, [pause, highlight]);

  const seekTo = useCallback((i: number) => {
    const segs = segments.current;
    const next = Math.max(0, Math.min(segs.length - 1, i));
    indexRef.current = next;
    setIndex(next);
    highlight(segs[next]?.el ?? null);
    if (playingRef.current) speakFrom(next);
  }, [highlight, speakFrom]);

  /** Jump to the start of the previous/next block (paragraph, list item…). */
  const jumpBlock = useCallback((dir: -1 | 1) => {
    const segs = segments.current;
    let i = indexRef.current;
    const cur = segs[i]?.el;
    if (dir > 0) {
      while (i < segs.length - 1 && segs[i].el === cur) i += 1;
    } else {
      // Back to this block's start, or the previous block's if we're already at it.
      while (i > 0 && segs[i - 1].el === cur) i -= 1;
      if (i === indexRef.current && i > 0) {
        const prev = segs[i - 1].el;
        i -= 1;
        while (i > 0 && segs[i - 1].el === prev) i -= 1;
      }
    }
    seekTo(i);
  }, [seekTo]);

  const changeRate = (r: number) => {
    rateRef.current = r;
    setRate(r);
    store(RATE_KEY, String(r));
    if (playingRef.current) speakFrom(indexRef.current);
  };

  const changeVoice = (name: string) => {
    const v = voices.find((x) => x.name === name);
    if (!v) return;
    voiceRef.current = v;
    setVoiceName(v.name);
    store(VOICE_KEY, v.name);
    if (playingRef.current) speakFrom(indexRef.current);
  };

  // Floating mini player once the inline one scrolls out of view.
  useEffect(() => {
    const el = anchor.current;
    if (!el || !open) {
      setFloating(false);
      return undefined;
    }
    // One rect read per scroll event is cheap; React skips the update when unchanged.
    const check = () => setFloating(el.getBoundingClientRect().bottom < 64);
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [open]);
  useEffect(() => {
    document.documentElement.classList.toggle('mj-listen-floating', open && floating);
    return () => document.documentElement.classList.remove('mj-listen-floating');
  }, [open, floating]);

  // Keyboard: space toggles while the player is focused; Escape closes the menu.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setMenu(false);
  };

  // Spoken length from the words we will actually read (code, tables… excluded).
  const [spokenWords, setSpokenWords] = useState(0);
  useEffect(() => {
    if (!supported) return undefined;
    const t = window.setTimeout(() => {
      if (!ensureSegments()) return;
      setSpokenWords(segments.current.reduce((n, sg) => n + sg.text.split(/\s+/).length, 0));
    }, 400);
    return () => window.clearTimeout(t);
  }, [supported, ensureSegments]);
  const listenMinutes = spokenWords ? spokenWords / WORDS_PER_MINUTE : minutes * 1.3;

  if (!supported) return null;

  const segs = segments.current;
  const done = segs.length ? (segs[index]?.offset ?? 0) / totalChars() : 0;
  const left = (listenMinutes / rate) * (1 - done);
  const currentVoice = voices.find((v) => v.name === voiceName);

  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!ensureSegments()) return;
    const box = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    const target = frac * totalChars();
    let i = 0;
    while (i < segs.length - 1 && segments.current[i + 1].offset <= target) i += 1;
    seekTo(i);
  };

  const controls = (compact: boolean) => (
    <div className={`mj-listen-bar${compact ? ' is-compact' : ''}`} onKeyDown={onKeyDown}>
      <button type="button" className="mj-listen-main" onClick={playing ? pause : play} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? I.pause : I.play}
      </button>
      {!compact && (
        <button type="button" className="mj-listen-icon" onClick={() => jumpBlock(-1)} aria-label="Previous paragraph">{I.back}</button>
      )}
      <div className="mj-listen-track-wrap">
        <div
          className="mj-listen-track"
          role="slider"
          tabIndex={0}
          aria-label="Position in article"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(done * 100)}
          onPointerDown={scrub}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') jumpBlock(1);
            if (e.key === 'ArrowLeft') jumpBlock(-1);
          }}
        >
          <span style={{ width: `${done * 100}%` }} />
          <i style={{ left: `${done * 100}%` }} />
        </div>
        <div className="mj-listen-time" aria-live="polite">
          <span>{playing ? 'Playing' : done > 0 ? 'Paused' : 'Ready'}</span>
          <span>{fmtMinutes(left)} left</span>
        </div>
      </div>
      {!compact && (
        <button type="button" className="mj-listen-icon" onClick={() => jumpBlock(1)} aria-label="Next paragraph">{I.fwd}</button>
      )}
      <div className="mj-listen-menu-wrap">
        <button type="button" className="mj-listen-rate" onClick={() => setMenu((m) => !m)} aria-expanded={menu} aria-label="Speed and voice">
          {rate}×
        </button>
        {menu && (
          <div className="mj-listen-menu" role="menu">
            <p>Speed</p>
            <div className="mj-listen-rates">
              {RATES.map((r) => (
                <button key={r} type="button" className={r === rate ? 'is-on' : ''} onClick={() => changeRate(r)}>{r}×</button>
              ))}
            </div>
            <p>Voice</p>
            <select value={voiceName ?? ''} onChange={(e) => changeVoice(e.target.value)} aria-label="Voice">
              {voices.slice(0, 24).map((v) => <option key={v.name} value={v.name}>{prettyVoice(v)}</option>)}
            </select>
            <small>Uses your device's built-in voices. Nothing is downloaded.</small>
          </div>
        )}
      </div>
      <button type="button" className="mj-listen-icon" onClick={stop} aria-label="Close player">{I.close}</button>
    </div>
  );

  return (
    <div className="mj-listen" ref={anchor}>
      {!open ? (
        <button type="button" className="mj-listen-pill" onClick={play} title={currentVoice ? `Voice: ${prettyVoice(currentVoice)}` : undefined}>
          <span className="mj-listen-pill-icon">{I.play}</span>
          <span>Listen to article</span>
          <span className="mj-listen-pill-time">{fmtMinutes(listenMinutes)}</span>
        </button>
      ) : (
        controls(false)
      )}
      {open && floating && (
        <div className="mj-listen-float" role="region" aria-label="Article audio">
          <span className="mj-listen-float-title"><span className={`mj-listen-eq${playing ? ' is-on' : ''}`}>{I.wave}</span>{title}</span>
          {controls(true)}
        </div>
      )}
    </div>
  );
}
