/**
 * The knowledge map: everything Mercury knows about you, as a mind map.
 *
 *   You → themes → sub-themes → notes, plus a sparse web of "related" links.
 *
 * Built locally from the text alone. No model calls, no embeddings, so it
 * costs nothing to rebuild and works offline. The pipeline (chosen after
 * comparing Obsidian/Logseq "hairball" graphs with TheBrain/Capacities-style
 * focused maps, see docs in the PR):
 *
 * 1. Terms. Words (lower-cased, stop-words dropped, lightly stemmed) plus
 *    named things ("Cosmic Stack", "VS Code") kept whole and weighted ×2,
 *    because in one-sentence notes names carry most of the meaning.
 * 2. Weights. BM25 (k1 1.2, b 0.3 for short texts) → unit vectors.
 * 3. Links. Cosine kNN with k = clamp(⌈ln n⌉, 5, 10); keep mutual pairs,
 *    one-way pairs only when strong (≥ 0.25), and every note's best match so
 *    nothing floats alone. Sparse by construction: no hairball.
 * 4. Themes. Louvain on that graph (deterministic order), resolution searched
 *    for 6–12 themes; each community split into connected pieces (Leiden's
 *    fix); crumbs merged into their strongest neighbour. Big themes get
 *    sub-themes the same way.
 * 5. Names. c-TF-IDF (BERTopic): a theme is named by the terms that are
 *    frequent in it and rare elsewhere, names preferred.
 * 6. Stability. Themes are matched to the previous map by member overlap
 *    (Jaccard ≥ 0.3) and keep their id, so colours and places stay put.
 *
 * Pure: give it notes, get a map. The store caches it and keeps the ids.
 */

export interface MapNote {
  id: string;
  text: string;
  kind: string;
  at: number;
  /** 0-1; scales the note's links (archive memories count half). */
  weight?: number;
}

export interface MapTheme {
  id: string;
  label: string;
  terms: string[];
  /** null for a top-level theme, else the theme it belongs to. */
  parent: string | null;
  size: number;
}

export interface MapLink { a: string; b: string; w: number }

export interface KnowledgeMap {
  themes: MapTheme[];
  /** note id → the theme it sits in (a sub-theme when its theme has them). */
  placement: Record<string, string>;
  links: MapLink[];
  stats: { notes: number; links: number; themes: number; ms: number };
}

/** Previous membership, for stable ids: theme id → note ids. */
export type ThemeMemory = Record<string, { parent: string | null; members: string[] }>;

// ── 1. Terms ─────────────────────────────────────────────────────────────────

const STOP = new Set(`a about above after again against all also am an and any are aren as at be because been before being below between both but by can
cannot could did do does doing don down during each few for from further had has have having he her here hers herself him himself his how i if in into is
isn it its itself just let me more most my myself no nor not now of off on once only or other ought our ours ourselves out over own same she should so some
such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while
who whom why will with would you your yours yourself yourselves via per etc using used use uses one two new get got make made like want wants wanted wanting
prefer prefers preferred user user's users owner salman mercury's s t re ve ll d m within without across around rather instead currently recently always
never often usually still yet already may might must need needs needed shall should would able unable thing things something someone anything way ways
lot lots much many very really just also even ever every each both either neither however therefore thus hence via based including include includes`.split(/\s+/));

/** Opening words that are capitalised only because they start the note. */
const OPENERS = new Set(['User', 'Users', 'Wants', 'Prefers', 'Uses', 'Is', 'Has', 'The', 'A', 'An', 'Likes', 'Loves', 'Dislikes', 'Works', 'Working',
  'Building', 'Created', 'Completed', 'Developing', 'Managing', 'Considering', 'Values', 'Cannot', 'Can', 'Used', 'Only', 'Prefer', 'Want', 'He', 'She',
  'They', 'His', 'Her', 'Their', 'This', 'That', 'When', 'If', 'For', 'In', 'On', 'At', 'To', 'Of', 'And', 'But', 'Or', 'As', 'With', 'Wanted', 'Decided',
  'Asked', 'Plans', 'Planning', 'Started', 'Finished', 'Owner', 'Mercury']);

/** Fine for linking, poor as a theme name: codes, dates, filler. */
const MONTHS = /^(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|yesterday|tomorrow)$/;
const WEAK_LABEL = new Set(['account', 'feature', 'access', 'expect', 'agent', 'work', 'code', 'data', 'file', 'system', 'app', 'tool', 'thing', 'part', 'time',
  'request', 'requested', 'task', 'version', 'step', 'mode', 'option', 'issue', 'help', 'support', 'interact', 'creat', 'build', 'implement', 'test', 'check', 'add']);
function labelable(t: string): boolean {
  const w = t.replace(/^e:/, '');
  if (/\d/.test(w) && !/^[a-z]+[\s-]?\d+(?:\.\d+)?\s*[a-z ]*$/i.test(w)) return false; // C25-G6, 2026-10-01
  if (/^[a-z]?\d+[a-z]?$/i.test(w) || /^[a-z]\d+/i.test(w)) return false; // C62, 7006804336
  if (MONTHS.test(w)) return false;
  if (!t.startsWith('e:') && WEAK_LABEL.has(w)) return false;
  return w.length >= 3;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

export interface Terms { counts: Map<string, number>; display: Map<string, string>; length: number }

/** Terms of one note: stemmed words, plus named things kept whole ("e:cosmic stack"). */
export function termsOf(text: string, stop: Set<string> = new Set()): Terms {
  const counts = new Map<string, number>();
  const display = new Map<string, string>();
  const add = (t: string, shown: string, n = 1) => { counts.set(t, (counts.get(t) ?? 0) + n); if (!display.has(t)) display.set(t, shown); };
  // Named things: runs of capitalised words (and acronyms / CamelCase), not the opener.
  const named = text.match(/\b(?:[A-Z][\w.+#-]*[A-Za-z0-9+#])(?:\s+(?:[A-Z][\w.+#-]*[A-Za-z0-9+#]|\d+(?:\.\d+)*))*/g) ?? [];
  for (let raw of named) {
    const words = raw.split(/\s+/);
    while (words.length && OPENERS.has(words[0])) words.shift();
    raw = words.join(' ').replace(/['’]s$/, '');
    if (raw.length < 2 || STOP.has(raw.toLowerCase()) || raw.toLowerCase().split(' ').some((w) => stop.has(w))) continue;
    add(`e:${raw.toLowerCase()}`, raw, 2);
  }
  let length = 0;
  for (const w of text.toLowerCase().replace(/['’]s\b/g, '').split(/[^a-z0-9+#]+/)) {
    if (w.length < 3 || STOP.has(w) || stop.has(w) || /^\d+$/.test(w)) continue;
    const s = stem(w);
    if (STOP.has(s)) continue;
    add(s, w);
    length += 1;
  }
  return { counts, display, length: Math.max(1, length) };
}

// ── 2-3. Weights and links ───────────────────────────────────────────────────

type Vec = Map<string, number>;

function vectors(terms: Terms[]): { vecs: Vec[]; df: Map<string, number> } {
  const n = terms.length;
  const df = new Map<string, number>();
  for (const t of terms) for (const k of t.counts.keys()) df.set(k, (df.get(k) ?? 0) + 1);
  const avg = terms.reduce((s, t) => s + t.length, 0) / Math.max(1, n);
  const k1 = 1.2;
  const b = 0.3;
  const vecs = terms.map((t) => {
    const v: Vec = new Map();
    let norm = 0;
    for (const [k, tf] of t.counts) {
      const d = df.get(k) ?? 1;
      if (d < 2) continue; // a term only this note has can't link it to anything
      const idf = Math.log(1 + (n - d + 0.5) / (d + 0.5));
      const w = idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * t.length) / avg)));
      v.set(k, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [k, w] of v) v.set(k, w / norm);
    return v;
  });
  return { vecs, df };
}

/** Link rules. Below `min` two notes only share filler; one-way picks need `oneWay`; a note's best match needs `best`. */
export const LINK_RULES = { min: 0.1, oneWay: 0.25, best: 0.15 };

/** Sparse kNN links: mutual pairs, strong one-way pairs, and each note's best match. */
export function linkNotes(vecs: Vec[], weights: number[] = []): Array<[number, number, number]> {
  const n = vecs.length;
  if (n < 2) return [];
  const k = Math.max(5, Math.min(10, Math.ceil(Math.log(n))));
  // Inverted index; very common terms are skipped for finding candidates (they still score).
  const postings = new Map<string, number[]>();
  vecs.forEach((v, i) => { for (const t of v.keys()) { let p = postings.get(t); if (!p) postings.set(t, (p = [])); p.push(i); } });
  const busy = Math.max(40, Math.floor(n * 0.15));
  const top: Array<Array<[number, number]>> = [];
  const score = new Float64Array(n);
  const touched: number[] = [];
  for (let i = 0; i < n; i++) {
    for (const [t, w] of vecs[i]) {
      const p = postings.get(t)!;
      if (p.length > busy) continue;
      for (const j of p) {
        if (j === i) continue;
        if (score[j] === 0) touched.push(j);
        score[j] += w * (vecs[j].get(t) ?? 0);
      }
    }
    // Busy terms add to pairs already found.
    for (const [t, w] of vecs[i]) {
      const p = postings.get(t)!;
      if (p.length <= busy) continue;
      for (const j of touched) score[j] += w * (vecs[j].get(t) ?? 0);
    }
    const best = touched.map((j) => [j, score[j]] as [number, number]).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, k);
    top.push(best.filter(([, s]) => s >= LINK_RULES.min));
    for (const j of touched) score[j] = 0;
    touched.length = 0;
  }
  const inTop = top.map((list) => new Map(list));
  const edges = new Map<string, [number, number, number]>();
  const keep = (i: number, j: number, s: number) => {
    const a = Math.min(i, j);
    const b = Math.max(i, j);
    const key = `${a}:${b}`;
    if (!edges.has(key)) edges.set(key, [a, b, s * Math.min(weights[a] ?? 1, weights[b] ?? 1)]);
  };
  for (let i = 0; i < n; i++) {
    top[i].forEach(([j, s], rank) => {
      if (inTop[j].has(i) || s >= LINK_RULES.oneWay || (rank === 0 && s >= LINK_RULES.best)) keep(i, j, s);
    });
  }
  return [...edges.values()];
}

// ── 4. Communities (Louvain) ─────────────────────────────────────────────────

interface WGraph { n: number; adj: Array<Map<number, number>>; strength: Float64Array; total: number }

function wgraph(n: number, edges: Array<[number, number, number]>): WGraph {
  const adj = Array.from({ length: n }, () => new Map<number, number>());
  for (const [a, b, w] of edges) {
    if (a === b) { adj[a].set(a, (adj[a].get(a) ?? 0) + 2 * w); continue; }
    adj[a].set(b, (adj[a].get(b) ?? 0) + w);
    adj[b].set(a, (adj[b].get(a) ?? 0) + w);
  }
  const strength = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) { let s = 0; for (const w of adj[i].values()) s += w; strength[i] = s; total += s; }
  return { n, adj, strength, total: total / 2 };
}

/** Louvain with a resolution γ. Deterministic: nodes are visited in index order. Returns a community per node. */
export function louvain(n: number, edges: Array<[number, number, number]>, resolution = 1): number[] {
  let g = wgraph(n, edges);
  let membership = Array.from({ length: n }, (_, i) => i);
  if (g.total === 0) return membership;
  const m2 = 2 * g.total;
  for (let level = 0; level < 12; level++) {
    const comm = Array.from({ length: g.n }, (_, i) => i);
    const tot = Float64Array.from(g.strength);
    let moved = false;
    for (let pass = 0; pass < 20; pass++) {
      let changed = 0;
      for (let i = 0; i < g.n; i++) {
        const ci = comm[i];
        const ki = g.strength[i];
        const links = new Map<number, number>();
        for (const [j, w] of g.adj[i]) if (j !== i) links.set(comm[j], (links.get(comm[j]) ?? 0) + w);
        tot[ci] -= ki;
        let best = ci;
        let gain = (links.get(ci) ?? 0) - (resolution * tot[ci] * ki) / m2;
        for (const [c, w] of links) {
          const dq = w - (resolution * tot[c] * ki) / m2;
          if (dq > gain + 1e-12 || (Math.abs(dq - gain) <= 1e-12 && c < best && dq > 0)) { gain = dq; best = c; }
        }
        tot[best] += ki;
        if (best !== ci) { comm[i] = best; changed++; }
      }
      if (changed === 0) break;
      moved = true;
    }
    if (!moved) break;
    // Renumber and aggregate.
    const ids = new Map<number, number>();
    for (const c of comm) if (!ids.has(c)) ids.set(c, ids.size);
    membership = membership.map((c) => ids.get(comm[c])!);
    const agg: Array<[number, number, number]> = [];
    for (let i = 0; i < g.n; i++) for (const [j, w] of g.adj[i]) if (i <= j) agg.push([ids.get(comm[i])!, ids.get(comm[j])!, i === j ? w / 2 : w]);
    const merged = new Map<string, [number, number, number]>();
    for (const [a, b, w] of agg) {
      const x = Math.min(a, b);
      const y = Math.max(a, b);
      const key = `${x}:${y}`;
      const e = merged.get(key);
      if (e) e[2] += w; else merged.set(key, [x, y, w]);
    }
    if (ids.size === g.n) break;
    g = wgraph(ids.size, [...merged.values()]);
  }
  return membership;
}

/** Split each community into its connected pieces (Leiden's guarantee, cheaply). */
function splitDisconnected(members: number[], adj: Array<Map<number, number>>): number[] {
  const out = new Array<number>(members.length).fill(-1);
  let next = 0;
  for (let s = 0; s < members.length; s++) {
    if (out[s] !== -1) continue;
    const id = next++;
    const stack = [s];
    out[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of adj[i].keys()) if (out[j] === -1 && members[j] === members[s]) { out[j] = id; stack.push(j); }
    }
  }
  return out;
}

/** Fold groups smaller than `min` into the neighbour group they link to most; unlinked crumbs gather as one group. */
function absorbCrumbs(groups: number[], adj: Array<Map<number, number>>, min: number): number[] {
  const out = groups.slice();
  for (let round = 0; round < 4; round++) {
    const size = new Map<number, number>();
    for (const c of out) size.set(c, (size.get(c) ?? 0) + 1);
    const small = [...size].filter(([, s]) => s < min).map(([c]) => c);
    if (!small.length) break;
    let changed = false;
    for (const c of small) {
      const pull = new Map<number, number>();
      out.forEach((ci, i) => { if (ci !== c) return; for (const [j, w] of adj[i]) if (out[j] !== c) pull.set(out[j], (pull.get(out[j]) ?? 0) + w); });
      const target = [...pull].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
      if (target) { out.forEach((ci, i) => { if (ci === c) out[i] = target[0]; }); changed = true; }
    }
    if (!changed) break;
  }
  return out;
}

/** Communities with a resolution searched so the count lands in [lo, hi] when possible. */
function themesFor(n: number, edges: Array<[number, number, number]>, lo: number, hi: number, minSize: number): number[] {
  const adj = wgraph(n, edges).adj;
  const run = (r: number) => absorbCrumbs(splitDisconnected(louvain(n, edges, r), adj), adj, minSize);
  const count = (g: number[]) => new Set(g).size;
  let best = run(1);
  let bestCount = count(best);
  if (bestCount >= lo && bestCount <= hi) return best;
  let a = 0.2;
  let b = 4;
  for (let i = 0; i < 9; i++) {
    const r = (a + b) / 2;
    const g = run(r);
    const c = count(g);
    const dist = (x: number) => (x < lo ? lo - x : x > hi ? x - hi : 0);
    if (dist(c) < dist(bestCount)) { best = g; bestCount = c; }
    if (c >= lo && c <= hi) return g;
    if (c < lo) a = r; else b = r;
  }
  return best;
}

// ── 5. Names (c-TF-IDF) ──────────────────────────────────────────────────────

function nameGroups(groups: number[][], terms: Terms[], avoid: Set<string> = new Set()): Array<{ label: string; terms: string[] }> {
  const tfc = groups.map((g) => { const m = new Map<string, number>(); for (const i of g) for (const [t, c] of terms[i].counts) m.set(t, (m.get(t) ?? 0) + c); return m; });
  const tf = new Map<string, number>();
  for (const m of tfc) for (const [t, c] of m) tf.set(t, (tf.get(t) ?? 0) + c);
  const words = tfc.map((m) => [...m.values()].reduce((s, c) => s + c, 0));
  const A = words.reduce((s, c) => s + c, 0) / Math.max(1, groups.length);
  const shown = (t: string) => { for (const i of groups.flat()) { const d = terms[i].display.get(t); if (d) return d; } return t.replace(/^e:/, ''); };
  return groups.map((g, gi) => {
    const scored = [...tfc[gi]]
      .filter(([t, c]) => c >= Math.min(2, g.length) && !avoid.has(t) && labelable(t))
      .map(([t, c]) => [t, c * Math.log(1 + A / (tf.get(t) ?? 1)) * (t.startsWith('e:') ? 1.5 : 1)] as [string, number])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const picked: string[] = [];
    const seenWords = new Set<string>([...avoid].filter((t) => !t.startsWith('e:')));
    for (const [t] of scored) {
      const words = t.replace(/^e:/, '').split(' ').map(stem);
      // "Cosmic Stack" and "stack", "DUNS" and "Dun" say the same thing.
      if (words.some((w) => [...seenWords].some((x) => x === w || (Math.min(x.length, w.length) >= 3 && (x.startsWith(w) || w.startsWith(x)))))) continue;
      words.forEach((w) => seenWords.add(w));
      picked.push(t);
      if (picked.length === 3) break;
    }
    const label = picked.slice(0, 2).map((t) => { const s = shown(t); return t.startsWith('e:') ? s : s[0].toUpperCase() + s.slice(1); }).join(' · ');
    return { label: label || 'Other notes', terms: picked };
  });
}

// ── 6. Stable ids ────────────────────────────────────────────────────────────

function jaccard(a: Set<string>, b: string[]): number {
  let inter = 0;
  for (const x of b) if (a.has(x)) inter++;
  return inter / (a.size + b.length - inter || 1);
}

function matchIds(groups: string[][], previous: Array<[string, string[]]>, prefix: string, taken: Set<string>): string[] {
  const pairs: Array<[number, number, number]> = [];
  groups.forEach((g, gi) => { const s = new Set(g); previous.forEach(([, members], pi) => { const j = jaccard(s, members); if (j >= 0.3) pairs.push([gi, pi, j]); }); });
  pairs.sort((a, b) => b[2] - a[2]);
  const ids = new Array<string | null>(groups.length).fill(null);
  const usedPrev = new Set<number>();
  for (const [gi, pi] of pairs) {
    if (ids[gi] || usedPrev.has(pi) || taken.has(previous[pi][0])) continue;
    ids[gi] = previous[pi][0];
    usedPrev.add(pi);
    taken.add(previous[pi][0]);
  }
  return ids.map((id, gi) => {
    if (id) return id;
    // New theme: an id from its first member, so it is stable for the same content.
    let h = 2166136261;
    for (const ch of [...groups[gi]].sort()[0] ?? `${gi}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    let nid = `${prefix}${(h >>> 0).toString(36)}`;
    while (taken.has(nid)) nid += 'x';
    taken.add(nid);
    return nid;
  });
}

// ── The map ──────────────────────────────────────────────────────────────────

export const LOOSE_THEME = 'loose';

export function buildKnowledgeMap(notes: MapNote[], previous: ThemeMemory = {}, opts: { now?: () => number; ownerNames?: string[] } = {}): KnowledgeMap {
  const clock = opts.now ?? (() => Date.now());
  const started = clock();
  const n = notes.length;
  if (n === 0) return { themes: [], placement: {}, links: [], stats: { notes: 0, links: 0, themes: 0, ms: 0 } };
  const stop = new Set((opts.ownerNames ?? []).flatMap((o) => { const f = o.trim().toLowerCase(); return f ? [f, ...f.split(/\s+/)] : []; }));
  const terms = notes.map((x) => termsOf(x.text, stop));
  const { vecs } = vectors(terms);
  const edges = linkNotes(vecs, notes.map((x) => x.weight ?? 1));

  // Top level: aim for 6-12 themes (fewer for a small brain).
  const lo = n < 40 ? 2 : n < 150 ? 4 : 6;
  const hi = n < 40 ? 5 : n < 150 ? 9 : 12;
  const top = themesFor(n, edges, lo, hi, Math.max(4, Math.round(n * 0.01)));
  const linked = new Set<number>();
  for (const [a, b] of edges) { linked.add(a); linked.add(b); }
  const groupsIdx = new Map<number, number[]>();
  const loose: number[] = [];
  top.forEach((c, i) => {
    if (!linked.has(i)) { loose.push(i); return; }
    let g = groupsIdx.get(c); if (!g) groupsIdx.set(c, (g = [])); g.push(i);
  });
  // Largest first, so themes read from most to least. Tiny leftovers join the loose notes.
  const groups = [...groupsIdx.values()].filter((g) => (g.length >= 3 ? true : (loose.push(...g), false))).sort((a, b) => b.length - a.length);
  const names = nameGroups(groups, terms);

  const prevTop = Object.entries(previous).filter(([, v]) => v.parent === null).map(([id, v]) => [id, v.members] as [string, string[]]);
  const taken = new Set<string>();
  const topIds = matchIds(groups.map((g) => g.map((i) => notes[i].id)), prevTop, 't', taken);

  const themes: MapTheme[] = [];
  const placement: Record<string, string> = {};
  groups.forEach((g, gi) => {
    const id = topIds[gi];
    themes.push({ id, label: names[gi].label, terms: names[gi].terms, parent: null, size: g.length });
    for (const i of g) placement[notes[i].id] = id;
    if (g.length <= 25) return;
    // Sub-themes inside a big theme, from the links within it.
    const local = new Map(g.map((i, li) => [i, li]));
    const sub = edges.filter(([a, b]) => local.has(a) && local.has(b)).map(([a, b, w]) => [local.get(a)!, local.get(b)!, w] as [number, number, number]);
    const parts = themesFor(g.length, sub, 2, Math.min(7, Math.ceil(g.length / 8)), 3);
    const partIdx = new Map<number, number[]>();
    parts.forEach((c, li) => { let p = partIdx.get(c); if (!p) partIdx.set(c, (p = [])); p.push(g[li]); });
    const subGroups = [...partIdx.values()].sort((a, b) => b.length - a.length);
    if (subGroups.length < 2) return;
    // Sub-themes say something their theme's name doesn't.
    const parentWords = names[gi].terms.flatMap((t) => [t, ...t.replace(/^e:/, '').split(' ').map(stem)]);
    const subNames = nameGroups(subGroups, terms, new Set(parentWords));
    const prevSub = Object.entries(previous).filter(([, v]) => v.parent === id).map(([sid, v]) => [sid, v.members] as [string, string[]]);
    const subIds = matchIds(subGroups.map((sg) => sg.map((i) => notes[i].id)), prevSub, `${id}.`, taken);
    subGroups.forEach((sg, si) => {
      themes.push({ id: subIds[si], label: subNames[si].label, terms: subNames[si].terms, parent: id, size: sg.length });
      for (const i of sg) placement[notes[i].id] = subIds[si];
    });
  });

  // Notes that share nothing worth a link with anything else: kept, under one quiet theme.
  if (loose.length) {
    themes.push({ id: LOOSE_THEME, label: 'Loose notes', terms: [], parent: null, size: loose.length });
    for (const i of loose) placement[notes[i].id] = LOOSE_THEME;
  }

  const links = edges.map(([a, b, w]) => ({ a: notes[a].id, b: notes[b].id, w: Number(w.toFixed(3)) }));
  return { themes, placement, links, stats: { notes: n, links: links.length, themes: themes.filter((t) => !t.parent && t.id !== LOOSE_THEME).length, ms: clock() - started } };
}

/** What to remember for next time: each theme's members, for stable ids. */
export function themeMemory(map: KnowledgeMap): ThemeMemory {
  const out: ThemeMemory = {};
  for (const t of map.themes) out[t.id] = { parent: t.parent, members: [] };
  for (const [note, theme] of Object.entries(map.placement)) {
    out[theme]?.members.push(note);
    const parent = map.themes.find((t) => t.id === theme)?.parent;
    if (parent) out[parent]?.members.push(note);
  }
  return out;
}
