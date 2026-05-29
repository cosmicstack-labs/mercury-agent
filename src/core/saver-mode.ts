import { logger } from '../utils/logger.js';
import type { MercuryConfig } from '../utils/config.js';
import { saveConfig } from '../utils/config.js';

/**
 * Token Saver Mode — battery-saver-style optimization for LLM calls.
 *
 * States:
 *   - 'off'     : disabled; the agent runs with normal parameters.
 *   - 'on'      : user explicitly enabled saver mode.
 *   - 'auto'    : auto-engaged because daily usage crossed the threshold.
 *
 * When active, the agent reduces maxOutputTokens, step budget, history
 * window, and appends a "be terse" suffix to the system prompt. The user
 * is notified once on auto-engage so they understand response style may
 * change. Lifetime tokens saved are tracked separately on the TokenBudget.
 */
export type SaverModeState = 'off' | 'on' | 'auto';

export const SAVER_OUTPUT_TOKEN_RATIO = 0.4;
export const SAVER_STEP_RATIO = 0.5;
export const SAVER_HISTORY_WINDOW = 4;
export const NORMAL_HISTORY_WINDOW = 10;

export class SaverMode {
  private state: SaverModeState = 'off';
  /** Auto-engage threshold as a percentage (0-100). 0 disables auto. */
  private autoThreshold: number;
  /** Set to true once we've notified the user about this auto-activation. */
  private autoNotified = false;
  /** Per-session counter of follow-up reminder messages shown after activation. */
  private postActivationHints = 0;
  /** True when the user disables auto explicitly for this run. */
  private autoEnabled: boolean;
  /** Opt-in cheap-provider routing flag (off by default). */
  private routingEnabled = false;

  constructor(private config: MercuryConfig) {
    const cfg = config.tokens as any;
    this.autoThreshold = typeof cfg.saverAutoThreshold === 'number' ? cfg.saverAutoThreshold : 75;
    this.autoEnabled = cfg.saverAutoEnabled !== false; // default true
    if (cfg.saverMode === true) {
      this.state = 'on';
    }
  }

  /** Get current state. */
  getState(): SaverModeState {
    return this.state;
  }

  /** True when any saver optimization should apply. */
  isActive(): boolean {
    return this.state !== 'off';
  }

  /** True if user manually enabled (vs. auto-engaged). */
  isManual(): boolean {
    return this.state === 'on';
  }

  isAuto(): boolean {
    return this.state === 'auto';
  }

  getAutoThreshold(): number {
    return this.autoThreshold;
  }

  isAutoEnabled(): boolean {
    return this.autoEnabled;
  }

  isRoutingEnabled(): boolean {
    return this.routingEnabled && this.isActive();
  }

  /** Manually enable saver mode (persisted). */
  enable(): void {
    this.state = 'on';
    this.autoNotified = false;
    this.postActivationHints = 0;
    (this.config.tokens as any).saverMode = true;
    saveConfig(this.config);
    logger.info('Token Saver Mode: manually enabled');
  }

  /** Manually disable saver mode (also clears auto state; persisted). */
  disable(): void {
    this.state = 'off';
    this.autoNotified = false;
    this.postActivationHints = 0;
    (this.config.tokens as any).saverMode = false;
    saveConfig(this.config);
    logger.info('Token Saver Mode: disabled');
  }

  /** Cycle between off → on → off. */
  toggle(): SaverModeState {
    if (this.state === 'off') {
      this.enable();
    } else {
      this.disable();
    }
    return this.state;
  }

  /** Set auto-engage threshold (0-100). 0 disables auto. Persisted. */
  setAutoThreshold(percent: number): void {
    const clamped = Math.max(0, Math.min(100, Math.round(percent)));
    this.autoThreshold = clamped;
    (this.config.tokens as any).saverAutoThreshold = clamped;
    saveConfig(this.config);
    logger.info({ threshold: clamped }, 'Token Saver auto-threshold updated');
  }

  /** Toggle automatic engagement on the configured threshold. Persisted. */
  setAutoEnabled(enabled: boolean): void {
    this.autoEnabled = enabled;
    (this.config.tokens as any).saverAutoEnabled = enabled;
    saveConfig(this.config);
    // If auto is disabled and we were in auto state, drop back to off.
    if (!enabled && this.state === 'auto') {
      this.state = 'off';
      this.autoNotified = false;
    }
    logger.info({ enabled }, 'Token Saver auto-engage toggled');
  }

  setRoutingEnabled(enabled: boolean): void {
    this.routingEnabled = enabled;
    logger.info({ enabled }, 'Token Saver cheap-provider routing toggled');
  }

  /**
   * Re-evaluate auto-engage state based on current usage percent.
   * Returns true if a transition just happened (off→auto), so caller
   * can emit a one-time notification.
   */
  evaluateAuto(usagePercent: number): { activated: boolean; deactivated: boolean } {
    let activated = false;
    let deactivated = false;
    if (!this.autoEnabled || this.autoThreshold <= 0) {
      return { activated, deactivated };
    }
    // Manual 'on' takes precedence — auto logic doesn't touch it.
    if (this.state === 'on') {
      return { activated, deactivated };
    }
    if (this.state === 'off' && usagePercent >= this.autoThreshold) {
      this.state = 'auto';
      this.autoNotified = false;
      this.postActivationHints = 0;
      activated = true;
      logger.info({ usagePercent, threshold: this.autoThreshold }, 'Token Saver Mode auto-engaged');
    } else if (this.state === 'auto' && usagePercent < this.autoThreshold - 5) {
      // Hysteresis: drop out only after we're well below the threshold.
      this.state = 'off';
      this.autoNotified = false;
      this.postActivationHints = 0;
      deactivated = true;
      logger.info({ usagePercent }, 'Token Saver Mode auto-disengaged');
    }
    return { activated, deactivated };
  }

  /**
   * Returns the user-facing notification once per auto-activation.
   * Subsequent calls return null until the next activation.
   */
  consumeAutoActivationNotice(): string | null {
    if (this.state !== 'auto' || this.autoNotified) return null;
    this.autoNotified = true;
    return (
      `⚡ Token Saver Mode auto-enabled (${this.autoThreshold}% of daily budget reached). ` +
      `Responses may be shorter and step limits lower. Disable with /saver off.`
    );
  }

  /**
   * Returns a short follow-up reminder for the first couple of responses
   * after activation, then null. Helps make optimization transparent.
   */
  consumePostActivationHint(): string | null {
    if (!this.isActive()) return null;
    if (this.postActivationHints >= 2) return null;
    this.postActivationHints++;
    return '⚡ Saver active — response optimized for token efficiency.';
  }

  /** System-prompt suffix that nudges the model toward terse output. */
  getSystemPromptSuffix(): string {
    if (!this.isActive()) return '';
    const reason = this.state === 'auto'
      ? `(auto-engaged at ${this.autoThreshold}% of daily token budget)`
      : '(user-enabled)';
    return (
      `\n\n**TOKEN SAVER MODE IS ACTIVE** ${reason}` +
      `\n- Be terse. No preamble, no restatement of the request, no closing pleasantries.` +
      `\n- Prefer short answers — at most one short paragraph unless explicitly asked for detail.` +
      `\n- When showing code, show only the changed lines unless context is essential.` +
      `\n- Skip optional explanations. Skip "Let me ..." narration.` +
      `\n- Avoid speculative tool calls; act only when necessary.`
    );
  }

  /** Reduce max output tokens when active; otherwise return original. */
  adjustMaxOutputTokens(original: number): number {
    if (!this.isActive()) return original;
    return Math.max(256, Math.floor(original * SAVER_OUTPUT_TOKEN_RATIO));
  }

  /** Reduce max steps when active; otherwise return original. */
  adjustMaxSteps(original: number): number {
    if (!this.isActive()) return original;
    return Math.max(3, Math.floor(original * SAVER_STEP_RATIO));
  }

  /** Reduce short-term history window when active; otherwise return original. */
  adjustHistoryWindow(original: number): number {
    if (!this.isActive()) return original;
    return Math.min(original, SAVER_HISTORY_WINDOW);
  }

  /** Human-readable status text for /saver and /status output. */
  getStatusText(lifetimeSaved: number, todaySaved: number): string {
    const label = this.state === 'auto'
      ? `AUTO (engaged at ${this.autoThreshold}% usage)`
      : this.state === 'on'
        ? 'ON (manual)'
        : 'OFF';
    const auto = this.autoEnabled
      ? `auto-engage at ${this.autoThreshold}%`
      : 'auto-engage disabled';
    const routing = this.routingEnabled ? 'cheap-provider routing ON' : 'cheap-provider routing OFF';
    return (
      `Token Saver Mode: ${label}\n` +
      `Settings: ${auto}, ${routing}\n` +
      `Saved today: ~${todaySaved.toLocaleString()} tokens · Lifetime: ~${lifetimeSaved.toLocaleString()} tokens`
    );
  }
}
