import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw } from "lucide-react";

/**
 * Crash recovery for a part of the window: one broken view (a graph that
 * runs out of memory, a malformed record) shows a calm card with Try again
 * instead of blanking the app. `resetKey` changing also resets it.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; label: string; resetKey?: unknown; fallback?: (retry: () => void, error: Error) => ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.label}] crashed`, error, info.componentStack);
  }

  componentDidUpdate(prev: { resetKey?: unknown }) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  retry = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.retry, error);
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="max-w-[420px] rounded-xl border border-line bg-surface p-5 text-center">
          <div className="text-base font-medium text-ink">{this.props.label} stopped working</div>
          <p className="mt-1 text-sm text-ink3">The rest of Mercury is fine. {error.message ? `(${error.message.slice(0, 160)})` : ""}</p>
          <button onClick={this.retry} className="mt-4 inline-flex h-9 items-center gap-2 rounded-md bg-accent px-3 text-sm font-medium text-on-accent"><RotateCcw size={14} /> Try again</button>
        </div>
      </div>
    );
  }
}
