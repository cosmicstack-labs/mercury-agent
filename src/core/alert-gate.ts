/**
 * Guards broadcasts to every channel ("Mercury is shutting down", plugin
 * alerts): a broadcast started while another is in flight is dropped (a
 * channel that forwards to the owner's chats can't loop), and the same
 * message isn't sent again within `repeatMs`.
 */
export class AlertGate {
  private active = false;
  private recent = new Map<string, number>();

  constructor(private readonly repeatMs = 5 * 60_000, private readonly now: () => number = Date.now) {}

  /** Run `send` unless this broadcast is nested or a recent repeat. Returns whether it ran. */
  async run(message: string, send: () => Promise<void>): Promise<'sent' | 'nested' | 'repeat'> {
    if (this.active) return 'nested';
    const t = this.now();
    for (const [m, at] of this.recent) if (t - at > this.repeatMs) this.recent.delete(m);
    if (this.recent.has(message)) return 'repeat';
    this.recent.set(message, t);
    this.active = true;
    try {
      await send();
    } finally {
      this.active = false;
    }
    return 'sent';
  }
}
