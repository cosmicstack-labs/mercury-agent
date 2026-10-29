/**
 * Reading people out of what Mercury learned, the way memories are actually
 * phrased ("User's wife is Heer", "Zayd and Shehzen are Salman's MTech
 * friends", "Zaid (also Zayd) dislikes Shehzen", "Salman married Heer").
 *
 * Pure functions; the store decides what to keep (person-standing.ts).
 * The owner is never a person here: their own names refer to "you".
 */

import { normalizeRelationship, relationWords } from './person-standing.js';

const NAME = '[A-Z][a-z]+(?:\\s+[A-Z][a-z]+){0,3}';
const NAME_LIST = `${NAME}(?:\\s*(?:,\\s*(?:and\\s+)?|\\s+and\\s+|\\s*&\\s*)${NAME})*`;
/** Up to two describing words before the role: "MTech friend", "best friend", "older brother". */
const MOD = '(?:[A-Za-z][A-Za-z-]*\\s+){0,2}?';

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "wife" → "[Ww]ife": roles match at either case, names still need a capital. */
function caseless(word: string): string {
  const e = escape(word);
  const first = word[0];
  return /[a-z]/i.test(first) ? `[${first.toLowerCase()}${first.toUpperCase()}]${e.slice(1)}` : e;
}

const ROLE = relationWords().map(caseless).join('|');

/** Every way the owner is named: "Salman Qureshi" → {"salman qureshi", "salman"}. */
export function ownerNameSet(owner: string | null | undefined): Set<string> {
  const out = new Set<string>(['user', 'the user']);
  const full = (owner ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (full) {
    out.add(full);
    out.add(full.split(' ')[0]);
  }
  return out;
}

/** The owner by any of their names, including longer forms ("Salman Qureshi" when the owner is "Salman"). */
export function isOwnerName(name: string, owner: Set<string>): boolean {
  const n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  if (owner.has(n)) return true;
  return owner.has(n.split(' ')[0]);
}

function ownerAlternation(owner: Set<string>): string {
  const names = [...owner].filter((n) => n !== 'user' && n !== 'the user').sort((a, b) => b.length - a.length);
  return names.map((n) => n.split(' ').map((w) => caseless(w)).join('\\s+')).join('|');
}

/** "my", "our", "user's", "the user's", "Salman's". */
function subject(owner: Set<string>): string {
  const alts = ownerAlternation(owner);
  return `(?:[Mm]y|[Oo]ur|(?:[Tt]he\\s+)?[Uu]ser(?:'s|s'|’s)${alts ? `|(?:${alts})(?:'s|’s)` : ''})`;
}

/** Aliases written in the text: "Zaid (Zayd)", "Shehzen (also spelled Shezan)", "X, aka Y". */
export function extractAliases(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const patterns = [
    new RegExp(`(${NAME})\\s*\\(\\s*(?:(?:also\\s+(?:spelled|known\\s+as|called)\\s+)|also\\s+|aka\\s+|or\\s+)?(${NAME})\\s*\\)`, 'g'),
    new RegExp(`(${NAME}),?\\s+(?:also\\s+spelled|also\\s+known\\s+as|aka)\\s+(${NAME})`, 'g'),
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) if (m[1] !== m[2]) out.push([m[1], m[2]]);
  }
  return out;
}

/** Drop alias parentheticals so "Zaid (Zayd) is user's friend" reads as "Zaid is user's friend". */
export function stripAliasNotes(text: string): string {
  return text.replace(new RegExp(`\\s*\\(\\s*(?:(?:also\\s+(?:spelled|known\\s+as|called)\\s+)|also\\s+|aka\\s+|or\\s+)?${NAME}\\s*\\)`, 'g'), '');
}

export interface RelationMention { name: string; relation: string }

/**
 * People with a stated relationship to the owner. `social` allows the
 * looser "Shazain is a colleague" form (no "user's") inside beliefs that
 * are already about relationships.
 */
export function extractOwnerRelations(
  raw: string,
  owner: Set<string>,
  names: (segment: string) => string[],
  opts: { social?: boolean } = {},
): RelationMention[] {
  const text = stripAliasNotes(raw.replace(/[\r\n]+/g, ' '));
  const SUBJ = subject(owner);
  const ownerAlts = ownerAlternation(owner);
  const found = new Map<string, RelationMention>();
  const add = (segment: string, relation: string) => {
    const rel = normalizeRelationship(relation);
    if (!rel) return;
    for (const n of names(segment)) {
      if (isOwnerName(n, owner)) continue;
      const key = n.toLowerCase();
      if (!found.has(key)) found.set(key, { name: n, relation: rel });
    }
  };
  let m: RegExpExecArray | null;

  // "my wife Heer", "User's wife is Heer", "User's partner Heer has…", "Salman's friends Zayd and Shehzen"
  const roleFirst = new RegExp(`${SUBJ}\\s+${MOD}(${ROLE})\\s*(?:is|are|was|named|called|,|:)?\\s+(${NAME_LIST})`, 'g');
  while ((m = roleFirst.exec(text)) !== null) add(m[2], m[1]);

  // "Heer is my wife", "Zayd and Shehzen are Salman's MTech friends", "Shehzen is the user's friend"
  const nameFirst = new RegExp(`(${NAME_LIST})\\s+(?:is|are|was|were)\\s+(?:(?:the|a|an|one\\s+of)\\s+)?(${SUBJ}\\s+)?${MOD}(${ROLE})\\b`, 'g');
  while ((m = nameFirst.exec(text)) !== null) {
    if (m[2] || opts.social) add(m[1], m[3]);
  }

  // "Shehzen, a friend of Salman", "Zara, the sister of the user"
  const appositive = new RegExp(`(${NAME}),\\s+(?:a|an|the)\\s+${MOD}(${ROLE})\\s+of\\s+(?:the\\s+)?(?:[Uu]ser|mine|me${ownerAlts ? `|${ownerAlts}` : ''})\\b`, 'g');
  while ((m = appositive.exec(text)) !== null) add(m[1], m[2]);

  // Marriage: "Salman married Heer", "User is married to someone named Heer", "Married to Heer since 2019".
  const married = new RegExp(`(?:\\b(?:[Uu]ser|I${ownerAlts ? `|${ownerAlts}` : ''})\\s+(?:is\\s+|was\\s+|got\\s+)?|^\\s*)[Mm]arried\\s+(?:to\\s+)?(?:someone\\s+named\\s+)?(${NAME})`, 'g');
  while ((m = married.exec(text)) !== null) add(m[1], 'spouse');

  return [...found.values()];
}

export interface PersonLink { a: string; b: string; type: string }

const LINK_VERBS: Array<[RegExp, string]> = [
  [/^(?:dislikes|hates|can't stand)$/i, 'dislikes'],
  [/^(?:likes|loves|admires)$/i, 'likes'],
  [/^knows$/i, 'knows'],
  [/^reports\s+to$/i, 'reports to'],
  [/^works\s+with$/i, 'works with'],
  [/^is\s+jealous\s+of$/i, 'jealous of'],
  [/^is\s+married\s+to$/i, 'spouse'],
  [/^is\s+dating$/i, 'partner'],
  [/^is\s+friends\s+with$/i, 'friend'],
];

/** Relationships between two people (never the owner): "Zaid dislikes Shehzen", "Ali is Sara's brother". */
export function extractPersonLinks(raw: string, owner: Set<string>, isName: (n: string) => boolean): PersonLink[] {
  const text = stripAliasNotes(raw.replace(/[\r\n]+/g, ' '));
  const out: PersonLink[] = [];
  const ok = (n: string) => isName(n) && !isOwnerName(n, owner);
  let m: RegExpExecArray | null;
  const verbs = new RegExp(`(${NAME})\\s+(?:also\\s+|really\\s+)?(dislikes|hates|can't stand|likes|loves|admires|knows|reports\\s+to|works\\s+with|is\\s+jealous\\s+of|is\\s+married\\s+to|is\\s+dating|is\\s+friends\\s+with)\\s+(?:the\\s+)?(${NAME})`, 'g');
  while ((m = verbs.exec(text)) !== null) {
    const type = LINK_VERBS.find(([re]) => re.test(m![2].replace(/\s+/g, ' ')))?.[1];
    if (type && ok(m[1]) && ok(m[3]) && m[1] !== m[3]) out.push({ a: m[1], b: m[3], type });
  }
  const possessive = new RegExp(`(${NAME})\\s+is\\s+(${NAME})(?:'s|’s)\\s+${MOD}(${ROLE})\\b`, 'g');
  while ((m = possessive.exec(text)) !== null) {
    const rel = normalizeRelationship(m[3]);
    if (rel && ok(m[1]) && ok(m[2]) && m[1] !== m[2]) out.push({ a: m[1], b: m[2], type: rel });
  }
  return out;
}
