/**
 * Who counts as a person in the Second Brain, and how sure Mercury is.
 *
 * A name seen once is not a person yet. Standing is a 0-100 score built
 * from evidence: how often the name recurs, whether it appears in social
 * memories (relationships, episodes) or only in work/project notes,
 * whether it has a relationship to the owner or to someone else, and
 * whether the owner or the model confirmed it. The score sets a tier:
 *
 *   known   shown everywhere (graph, People). Needs a solid score AND at
 *           least one tie: a relationship to you, a relationship to
 *           another person, or a model-confirmed person or pet.
 *   shadow  kept, but dimmed and out of the way until more evidence
 *           arrives or you confirm them.
 *   faint   one stray mention; listed only under "All".
 *
 * The known list has a soft cap (KNOWN_CAP, about Dunbar's number). It is
 * internal and never shown: past it the bar to stay known rises with each
 * extra person, so a big social life still fits while weak names fade to
 * shadow. Owner decisions always win.
 */

export type PersonTier = 'known' | 'shadow' | 'faint';

export interface PersonEvidence {
  /** Distinct memories and beliefs that mention the person. */
  mentions: number;
  /** Of those, how many are social (relationship / episode). */
  socialMentions: number;
  /** Distinct local days the mentions span. */
  distinctDays: number;
  /** Relationship to the owner, if any ("wife", "friend", "known" = none). */
  relationship: string | null;
  /** Relationships to other people. */
  personLinks: number;
  kind: string | null;
  verifiedBy: string | null;
  ownerEdited: boolean;
}

export interface PersonStanding {
  score: number;
  tier: PersonTier;
  /** Plain reasons, for the People screen ("4 mentions", "your wife"). */
  reasons: string[];
}

/** Most people keep about 150 stable relationships (Dunbar). A soft cap, internal only. */
export const KNOWN_CAP = 150;
export const KNOWN_MIN_SCORE = 55;
export const SHADOW_MIN_SCORE = 25;

export function standingOf(e: PersonEvidence): PersonStanding {
  const reasons: string[] = [];
  if (e.verifiedBy === 'model-rejected') return { score: 0, tier: 'faint', reasons: ['the model judged this is not a person'] };
  if (e.ownerEdited || e.verifiedBy === 'owner') {
    return { score: 100, tier: 'known', reasons: ['confirmed by you'] };
  }

  let score = 0;
  // Recurrence: the main signal. One mention is weak; repeated mentions add up, with diminishing returns.
  score += e.mentions <= 0 ? 0 : e.mentions === 1 ? 15 : e.mentions === 2 ? 32 : e.mentions === 3 ? 42 : e.mentions < 8 ? 50 : 56;
  if (e.mentions > 0) reasons.push(`${e.mentions} mention${e.mentions === 1 ? '' : 's'}`);
  if (e.socialMentions >= 2) { score += 18; reasons.push('in your relationships and moments'); }
  else if (e.socialMentions === 1) score += 8;
  const rel = specificRelationship(e.relationship);
  if (rel) { score += 25; reasons.push(`your ${rel}`); }
  if (e.personLinks > 0) { score += 10; reasons.push(`connected to ${e.personLinks} other${e.personLinks === 1 ? '' : 's'}`); }
  if (e.distinctDays >= 2) score += 5;
  if (e.verifiedBy === 'model' && (e.kind === 'person' || e.kind === 'pet')) { score += 15; reasons.push('checked by the model'); }
  score = Math.max(0, Math.min(99, Math.round(score)));

  // Known needs a real tie: a relationship to you, to someone else, or a confirmed person/pet.
  // Being mentioned often (a city, a product) is not enough on its own.
  const tied = !!rel || e.personLinks > 0 || (e.verifiedBy === 'model' && (e.kind === 'person' || e.kind === 'pet'));
  if (score >= KNOWN_MIN_SCORE && tied) return { score, tier: 'known', reasons };
  if (score >= SHADOW_MIN_SCORE) {
    if (!tied) reasons.push('no relationship yet');
    return { score, tier: 'shadow', reasons };
  }
  return { score, tier: 'faint', reasons: reasons.length ? reasons : ['seen once'] };
}

/**
 * The soft cap. Up to `cap` known people, nothing changes. Past it, each
 * extra place needs a higher score (+1 per `step` people beyond the cap, on
 * top of a margin), so the list keeps growing for strong ties and stops
 * growing for weak ones. Owner-confirmed people never move. Nothing here is
 * worded for the user: someone past the bar simply needs more evidence.
 */
export function capKnown<T extends { standing: PersonStanding; ownerEdited: boolean }>(people: T[], cap = KNOWN_CAP, step = 10): T[] {
  const known = people.filter((p) => p.standing.tier === 'known' && !p.ownerEdited).sort((a, b) => b.standing.score - a.standing.score);
  const owner = people.filter((p) => p.standing.tier === 'known' && p.ownerEdited).length;
  const room = Math.max(0, cap - owner);
  known.forEach((p, i) => {
    if (i < room) return;
    const bar = KNOWN_MIN_SCORE + 15 + Math.floor((i - room) / step);
    if (p.standing.score < bar) p.standing = { ...p.standing, tier: 'shadow', reasons: [...p.standing.reasons, 'needs more evidence'] };
  });
  return people;
}

// ── Relationships and their cardinality ─────────────────────────────────

export type Cardinality = 'one' | 'many';

interface RelationSpec {
  /** Canonical label. */
  label: string;
  /** "one": you have at most one at a time (spouse, mother). "many": any number (friends, children). */
  cardinality: Cardinality;
  /** One-to-one relations in the same group exclude each other (wife / husband / spouse / partner). */
  group?: string;
}

const RELATIONS: Record<string, RelationSpec> = {
  wife: { label: 'wife', cardinality: 'one', group: 'spouse' },
  husband: { label: 'husband', cardinality: 'one', group: 'spouse' },
  spouse: { label: 'spouse', cardinality: 'one', group: 'spouse' },
  partner: { label: 'partner', cardinality: 'one', group: 'spouse' },
  fiance: { label: 'fiancé', cardinality: 'one', group: 'spouse' },
  fiancee: { label: 'fiancée', cardinality: 'one', group: 'spouse' },
  girlfriend: { label: 'girlfriend', cardinality: 'one', group: 'spouse' },
  boyfriend: { label: 'boyfriend', cardinality: 'one', group: 'spouse' },
  mother: { label: 'mother', cardinality: 'one', group: 'mother' },
  father: { label: 'father', cardinality: 'one', group: 'father' },
  son: { label: 'son', cardinality: 'many' },
  daughter: { label: 'daughter', cardinality: 'many' },
  child: { label: 'child', cardinality: 'many' },
  brother: { label: 'brother', cardinality: 'many' },
  sister: { label: 'sister', cardinality: 'many' },
  sibling: { label: 'sibling', cardinality: 'many' },
  cousin: { label: 'cousin', cardinality: 'many' },
  uncle: { label: 'uncle', cardinality: 'many' },
  aunt: { label: 'aunt', cardinality: 'many' },
  grandmother: { label: 'grandmother', cardinality: 'many' },
  grandfather: { label: 'grandfather', cardinality: 'many' },
  family: { label: 'family', cardinality: 'many' },
  friend: { label: 'friend', cardinality: 'many' },
  colleague: { label: 'colleague', cardinality: 'many' },
  cofounder: { label: 'co-founder', cardinality: 'many' },
  manager: { label: 'manager', cardinality: 'one', group: 'manager' },
  boss: { label: 'boss', cardinality: 'one', group: 'manager' },
  mentor: { label: 'mentor', cardinality: 'many' },
  mentee: { label: 'mentee', cardinality: 'many' },
  client: { label: 'client', cardinality: 'many' },
  neighbour: { label: 'neighbour', cardinality: 'many' },
  pet: { label: 'pet', cardinality: 'many' },
};

const ALIASES: Record<string, string> = {
  wives: 'wife', husbands: 'husband', mom: 'mother', mum: 'mother', mothers: 'mother', moms: 'mother', ammi: 'mother',
  dad: 'father', fathers: 'father', dads: 'father', abbu: 'father', papa: 'father',
  sons: 'son', daughters: 'daughter', children: 'child', kid: 'child', kids: 'child',
  brothers: 'brother', sisters: 'sister', siblings: 'sibling', cousins: 'cousin', uncles: 'uncle', aunts: 'aunt', aunty: 'aunt', auntie: 'aunt',
  grandma: 'grandmother', granny: 'grandmother', grandpa: 'grandfather',
  families: 'family', friends: 'friend', 'best friend': 'friend', bestie: 'friend',
  colleagues: 'colleague', coworker: 'colleague', coworkers: 'colleague', 'co-worker': 'colleague', 'co-workers': 'colleague',
  teammate: 'colleague', teammates: 'colleague', 'team member': 'colleague', developer: 'colleague', developers: 'colleague', cto: 'colleague', ceo: 'colleague',
  'co-founder': 'cofounder', cofounders: 'cofounder', 'co-founders': 'cofounder',
  partners: 'partner', lover: 'partner', 'fiancé': 'fiance', 'fiancée': 'fiancee', neighbor: 'neighbour', neighbours: 'neighbour', neighbors: 'neighbour',
  clients: 'client', mentors: 'mentor', mentees: 'mentee', managers: 'manager',
};

/** "Mom" → "mother", "co-workers" → "colleague"; unknown words pass through lower-cased. */
export function normalizeRelationship(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!k) return null;
  const key = ALIASES[k] ?? k;
  return RELATIONS[key]?.label ?? k;
}

/** The relation words the extractor looks for, longest first. */
export function relationWords(): string[] {
  return [...new Set([...Object.keys(RELATIONS), ...Object.keys(ALIASES)])].sort((a, b) => b.length - a.length);
}

export function relationSpec(relationship: string | null | undefined): RelationSpec | null {
  const n = normalizeRelationship(relationship);
  if (!n) return null;
  const key = Object.keys(RELATIONS).find((k) => RELATIONS[k].label === n);
  return key ? RELATIONS[key] : null;
}

export function cardinalityOf(relationship: string | null | undefined): Cardinality {
  return relationSpec(relationship)?.cardinality ?? 'many';
}

/** The exclusive group of a one-to-one relation ("spouse" for wife/husband/partner), or null. */
export function exclusiveGroup(relationship: string | null | undefined): string | null {
  const s = relationSpec(relationship);
  return s && s.cardinality === 'one' ? s.group ?? s.label : null;
}

/** A relationship worth showing, or null for none / the placeholder "known". */
export function specificRelationship(relationship: string | null | undefined): string | null {
  const n = normalizeRelationship(relationship);
  return n && n !== 'known' ? n : null;
}

/** For the edit form: every relation with its cardinality. */
export function relationCatalog(): Array<{ label: string; cardinality: Cardinality }> {
  const seen = new Set<string>();
  const out: Array<{ label: string; cardinality: Cardinality }> = [];
  for (const spec of Object.values(RELATIONS)) {
    if (seen.has(spec.label)) continue;
    seen.add(spec.label);
    out.push({ label: spec.label, cardinality: spec.cardinality });
  }
  return out;
}
