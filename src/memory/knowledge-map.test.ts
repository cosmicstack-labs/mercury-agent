import { describe, expect, it } from 'vitest';
import { buildKnowledgeMap, LOOSE_THEME, louvain, termsOf, themeMemory, type MapNote } from './knowledge-map.js';

const note = (id: string, text: string, kind = 'fact'): MapNote => ({ id, text, kind, at: 0 });

/** Three clear subjects, phrased the way beliefs are. */
function brain(): MapNote[] {
  const garden = ['grows tomatoes in the garden', 'waters the garden tomatoes every morning', 'wants raised beds for the garden tomatoes',
    'composts kitchen scraps for the garden', 'planted basil beside the garden tomatoes', 'bought a hose for the garden'];
  const guitar = ['practises guitar chords nightly', 'wants a Fender guitar for chords practice', 'learning guitar scales and chords',
    'records guitar covers on weekends', 'restrings the guitar every month', 'takes guitar lessons for chords'];
  const rust = ['is learning Rust ownership and borrowing', 'writes a Rust CLI with Cargo', 'prefers Rust over Go for the CLI',
    'reads the Rust book on ownership', 'publishes Rust crates with Cargo', 'debugs Rust borrowing errors in the CLI'];
  return [
    ...garden.map((t, i) => note(`g${i}`, `User ${t}`, 'preference')),
    ...guitar.map((t, i) => note(`m${i}`, `User ${t}`, 'goal')),
    ...rust.map((t, i) => note(`r${i}`, `User ${t}`, 'project')),
  ];
}

const themeOf = (map: ReturnType<typeof buildKnowledgeMap>, id: string) => {
  const t = map.placement[id];
  return map.themes.find((x) => x.id === t)?.parent ?? t;
};

describe('knowledge map', () => {
  it('groups notes by subject and names each theme from its own words', () => {
    const map = buildKnowledgeMap(brain(), {}, { ownerNames: ['Test Owner'] });
    const groups = ['g', 'm', 'r'].map((p) => new Set(Array.from({ length: 6 }, (_, i) => themeOf(map, `${p}${i}`))));
    for (const g of groups) expect(g.size).toBe(1);
    expect(new Set(groups.map((g) => [...g][0])).size).toBe(3);
    const labels = map.themes.map((t) => t.label.toLowerCase()).join(' | ');
    expect(labels).toMatch(/garden|tomato/);
    expect(labels).toMatch(/guitar|chord/);
    expect(labels).toMatch(/rust|cli|cargo/);
  });

  it('keeps links sparse: a handful per note, never all pairs', () => {
    const map = buildKnowledgeMap(brain());
    expect(map.links.length).toBeGreaterThan(9);
    expect(map.links.length).toBeLessThan((18 * 17) / 2 / 3);
    const same = map.links.filter((l) => themeOf(map, l.a) === themeOf(map, l.b)).length;
    expect(same / map.links.length).toBeGreaterThan(0.9);
  });

  it('a note that shares nothing goes to Loose notes, not into a theme', () => {
    const map = buildKnowledgeMap([...brain(), note('x', 'Zebra quokka marmalade')]);
    expect(map.placement.x).toBe(LOOSE_THEME);
    expect(map.stats.notes).toBe(19);
  });

  it('theme ids survive a rebuild with new notes', () => {
    const first = buildKnowledgeMap(brain());
    const ids = (m: typeof first) => ['g0', 'm0', 'r0'].map((id) => themeOf(m, id));
    const more = [...brain(), note('g9', 'User harvests garden tomatoes in August'), note('r9', 'User refactors the Rust CLI with Cargo')];
    const second = buildKnowledgeMap(more, themeMemory(first));
    expect(ids(second)).toEqual(ids(first));
    expect(themeOf(second, 'g9')).toBe(themeOf(second, 'g0'));
  });

  it('never names a theme after the owner', () => {
    const notes = brain().map((n) => ({ ...n, text: n.text.replace('User', 'Salman Qureshi') }));
    const map = buildKnowledgeMap(notes, {}, { ownerNames: ['Salman Qureshi'] });
    expect(map.themes.map((t) => t.label).join(' ')).not.toMatch(/salman|qureshi/i);
  });

  it('keeps named things whole and drops the opening word', () => {
    const t = termsOf('Prefers VS Code over Cosmic Stack tools');
    expect(t.counts.has('e:vs code')).toBe(true);
    expect(t.counts.has('e:cosmic stack')).toBe(true);
    expect([...t.counts.keys()].some((k) => k.includes('prefers'))).toBe(false);
  });

  it('louvain splits two cliques joined by one edge', () => {
    const edges: Array<[number, number, number]> = [];
    for (const base of [0, 5]) for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) edges.push([base + i, base + j, 1]);
    edges.push([4, 5, 0.1]);
    const c = louvain(10, edges);
    expect(new Set(c.slice(0, 5)).size).toBe(1);
    expect(new Set(c.slice(5)).size).toBe(1);
    expect(c[0]).not.toBe(c[9]);
  });

  it('an empty brain is an empty map', () => {
    expect(buildKnowledgeMap([]).themes).toEqual([]);
  });
});
