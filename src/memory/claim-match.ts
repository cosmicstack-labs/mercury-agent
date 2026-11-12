/**
 * Is it the same claim? One check, used when a belief is learned (so a
 * second wording supports the first instead of becoming a copy) and by the
 * tidy pass that folds copies already in the brain.
 *
 * A claim is reduced to its meaning-carrying words: the owner, however they
 * are named ("I", "my", "the user's", "Salman's"), is dropped, since every
 * belief is about them; synonyms collapse ("wife", "husband", "spouse",
 * "married" are one relation; "buy"/"purchase", "likes"/"prefers"); filler
 * goes; words are lightly stemmed. Two claims are the same when their words
 * mostly agree, or when one says exactly what the other says plus a little
 * more ("Heer is my wife" / "Heer is the user's wife, married since 2019").
 * A claim and its negation are never the same.
 *
 * Pure and local: no model calls.
 */

const FILLER = new Set(`a an the this that these those is are was were be been being am has have had having do does did will would shall should can could may might must
of to in on at by for from with into onto about as and or but so if then than also just only very really still currently recently now already
who whom whose which what when where how why it its they them their there here someone something named called known
user users owner owners person people i me my mine we us our ours you your yours he him his she her hers
want wants wanted wanting aim aims aiming plan plans planning planned goal goals try trying tries tried
some any all each every both more most much many other another such same own via per etc one`.split(/\s+/));

/** Words that flip a claim. */
const NEGATION = new Set(['not', 'no', 'never', 'none', 'nobody', 'nothing', 'without', 'avoid', 'avoids', 'avoided', 'avoiding', 'cannot', 'stop', 'stopped', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'wont', 'cant']);

/** One word per meaning. Keys are already lower-cased and stemmed. */
const SYNONYM: Record<string, string> = {
  wife: 'spouse', husband: 'spouse', spouse: 'spouse', married: 'spouse', marry: 'spouse', marri: 'spouse', marriage: 'spouse',
  cofounder: 'cofounder',
  purchase: 'buy', bought: 'buy', buy: 'buy',
  like: 'like', love: 'like', enjoy: 'like', prefer: 'like', fond: 'like', favour: 'like', favor: 'like', favourite: 'like', favorite: 'like',
  dislike: 'dislike', hate: 'dislike', detest: 'dislike',
  kid: 'child', son: 'child', daughter: 'child', child: 'child', children: 'child',
  mom: 'mother', mum: 'mother', mother: 'mother', dad: 'father', father: 'father',
};

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 6 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es') && /(?:ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

export interface ClaimSignature {
  /** Meaning-carrying words, stemmed and with synonyms collapsed. */
  words: Set<string>;
  /** The claim is negated ("doesn't like", "never", "avoid"). */
  negated: boolean;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Owner names → a pattern that removes them (and their possessive).
 * Longest first so "salman qureshi" goes before "salman".
 */
function ownerPattern(ownerNames: Iterable<string>): RegExp | null {
  const names = [...new Set([...ownerNames].map((n) => n.trim().toLowerCase()).filter((n) => n && n !== 'user' && n !== 'the user'))]
    .sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  return new RegExp(`\\b(?:${names.map((n) => n.split(/\s+/).map(escapeRe).join('\\s+')).join('|')})(?:'s|s')?\\b`, 'g');
}

const ownerPatterns = new Map<string, RegExp | null>();

export function claimSignature(text: string, ownerNames: Iterable<string> = []): ClaimSignature {
  const key = [...ownerNames].join('\u0000');
  let owner = ownerPatterns.get(key);
  if (owner === undefined) { owner = ownerPattern(ownerNames); ownerPatterns.set(key, owner); }
  let s = text.toLowerCase().replace(/[’‘`]/g, "'");
  if (owner) s = s.replace(owner, ' ');
  s = s
    .replace(/\bco[\s-]+founders?\b/g, 'cofounder')
    .replace(/\b(\w+)n't\b/g, '$1nt')
    .replace(/\bcan not\b/g, 'cannot')
    .replace(/'s\b|s'(?=\s|$)/g, '');
  const words = new Set<string>();
  let negated = false;
  for (const raw of s.split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    if (NEGATION.has(raw)) { negated = true; continue; }
    if (FILLER.has(raw)) continue;
    if (raw.length < 2 && !/\d/.test(raw)) continue;
    const st = stem(raw);
    if (FILLER.has(st)) continue;
    words.add(SYNONYM[st] ?? SYNONYM[raw] ?? st);
  }
  return { words, negated };
}

/**
 * Thresholds: words mostly agree, or one claim is the other plus a little
 * (at most `extraWords` more words, or half as many again for long claims),
 * so "Heer is my wife" folds into "…, married since 2019" but not into
 * "Married to Heer; about to become a father", which says more.
 */
export const SAME_CLAIM = { jaccard: 0.7, containedSmallMin: 2, extraWords: 2 };

const hasDigit = (w: string) => /\d/.test(w);

/**
 * Words that change who someone is or how the owner feels. A longer claim
 * that adds one of these says something new ("Heer is my wife" vs "…, about
 * to become a father"; "Zayd is my friend" vs "Zayd dislikes Shehzen").
 */
const KEY_WORDS = new Set(['spouse', 'child', 'mother', 'father', 'parent', 'brother', 'sister', 'sibling', 'niece', 'nephew', 'cousin', 'uncle', 'aunt',
  'grandmother', 'grandfather', 'friend', 'cofounder', 'colleague', 'boss', 'manager', 'girlfriend', 'boyfriend', 'fiance', 'fiancee', 'pet', 'like', 'dislike',
  'pregnant', 'pregnancy', 'born', 'died', 'divorce', 'divorced']);

/** How alike two signatures are: 0 (nothing shared) … 1 (same words). Negations never match. */
export function claimSimilarity(a: ClaimSignature, b: ClaimSignature): { jaccard: number; contained: boolean } {
  if (a.negated !== b.negated || a.words.size === 0 || b.words.size === 0) return { jaccard: 0, contained: false };
  const [small, big] = a.words.size <= b.words.size ? [a.words, b.words] : [b.words, a.words];
  let shared = 0;
  for (const w of small) if (big.has(w)) shared++;
  // Different numbers are different claims: "married in 2019" vs "married on October 9, 2025".
  const numsSmall = [...small].filter(hasDigit);
  const numsBig = [...big].filter(hasDigit);
  if (numsSmall.length && numsBig.length && numsSmall.some((n) => !big.has(n))) return { jaccard: 0, contained: false };
  // A relation or feeling only one side has: different claims, however alike the rest.
  for (const w of big) if (!small.has(w) && KEY_WORDS.has(w)) return { jaccard: 0, contained: false };
  for (const w of small) if (!big.has(w) && KEY_WORDS.has(w)) return { jaccard: 0, contained: false };
  const jaccard = shared / (small.size + big.size - shared);
  const contained = shared === small.size && small.size >= SAME_CLAIM.containedSmallMin
    && big.size - small.size <= Math.max(SAME_CLAIM.extraWords, Math.floor(small.size / 2));
  return { jaccard, contained };
}

/** Same words, near enough: either wording can stand for the other. */
export function sameWording(a: ClaimSignature, b: ClaimSignature): boolean {
  return claimSimilarity(a, b).jaccard >= SAME_CLAIM.jaccard;
}

export function sameClaim(a: ClaimSignature, b: ClaimSignature): boolean {
  const { jaccard, contained } = claimSimilarity(a, b);
  return jaccard >= SAME_CLAIM.jaccard || contained;
}
