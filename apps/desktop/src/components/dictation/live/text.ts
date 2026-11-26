/**
 * What live dictation puts in the message box (the phones' DictationText, with
 * a cursor): the text before the cursor, the finished words, the live partial
 * (replaced as it's heard), then the text after the cursor. If the owner edits
 * the box while talking, their text wins: the dictation carries on where it was
 * (before what followed the cursor, when that's still there, else at the end).
 */
export class DictationText {
  private before: string;
  private after: string;
  private finals = "";
  private live = "";
  /** The last text this put in the box. */
  private written: string;

  constructor(draft: string, cursor = draft.length) {
    const at = Math.max(0, Math.min(cursor, draft.length));
    this.before = draft.slice(0, at);
    this.after = draft.slice(at);
    this.written = draft;
  }

  get text(): string {
    const spoken = join(this.finals, this.live);
    if (!spoken) return this.before + this.after;
    return join(join(this.before, spoken), this.after);
  }

  /** Where the cursor goes: right after the spoken words. */
  get cursor(): number {
    const spoken = join(this.finals, this.live);
    return spoken ? join(this.before, spoken).length : this.before.length;
  }

  /** New partial text (all of what isn't final yet); returns the box's new text. */
  partial(t: string, draft: string): string {
    this.adopt(draft);
    this.live = t.trim();
    this.written = this.text;
    return this.written;
  }

  /** Finished text: it replaces the partial it came from. */
  final(t: string, draft: string): string {
    this.adopt(draft);
    this.finals = join(this.finals, t.trim());
    this.live = "";
    this.written = this.text;
    return this.written;
  }

  /** The partial that never became final is kept as it stands (the stream ended). */
  settle(draft: string): string {
    return this.final(this.live, draft);
  }

  private adopt(draft: string): void {
    if (draft === this.written) return;
    let d = draft;
    // What followed the cursor is still at the end: keep dictating before it.
    let after = "";
    if (this.after && d.endsWith(this.after)) { after = this.after; d = d.slice(0, d.length - after.length); }
    // The owner's edit kept the partial: it'll come again, final.
    if (this.live && d.trimEnd().endsWith(this.live)) d = d.trimEnd().slice(0, d.trimEnd().length - this.live.length);
    this.before = d.endsWith(" ") ? d.slice(0, -1) : d;
    this.after = after;
    this.finals = "";
    this.live = "";
  }
}

/** Joins two pieces with one space, none before punctuation or after a space or new line. */
export function join(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  if (/\s$/.test(a) || /^\s/.test(b) || ",.!?;:)".includes(b[0])) return a + b;
  return `${a} ${b}`;
}
