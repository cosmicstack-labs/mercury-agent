/**
 * ScriptPlayer — hands scripted steps to whichever provider the agent calls
 * and records every model call (prompt, tool choice, timing) so tests can
 * inspect exactly what the loop sent and when.
 */
import type { LanguageModelV3CallOptions, LanguageModelV3Prompt } from '@ai-sdk/provider';
import type { ScenarioTurn, ScriptedStep, ScriptedToolCall } from './fixture.js';

export interface ProviderCallRecord {
  index: number;
  provider: string;
  model: string;
  mode: 'stream' | 'generate';
  startedAt: number;
  endedAt?: number;
  prompt: LanguageModelV3Prompt;
  toolChoice?: unknown;
  toolNames: string[];
  step?: ScriptedStep;
  error?: string;
  /** Tool call ids this step emitted (stable: eval-c<call>-<n>). */
  toolCallIds: string[];
}

export class ScriptPlayer {
  readonly calls: ProviderCallRecord[] = [];
  /** True when a model call found no scripted step left (and no onExhausted). */
  exhausted = false;
  private steps: ScriptedStep[] = [];
  private cursor = 0;
  private onExhausted?: (callIndex: number) => ScriptedStep;
  private readonly recorded = new Map<string, ScriptedToolCall>();

  constructor(private readonly clock: () => number) {}

  load(turn: ScenarioTurn): void {
    this.steps = [...(turn.steps ?? [])];
    this.cursor = 0;
    this.onExhausted = turn.onExhausted;
    this.exhausted = false;
    this.calls.length = 0;
    this.recorded.clear();
  }

  remaining(): number {
    return this.steps.length - this.cursor;
  }

  begin(provider: string, model: string, mode: 'stream' | 'generate', options: LanguageModelV3CallOptions): ProviderCallRecord {
    const record: ProviderCallRecord = {
      index: this.calls.length,
      provider,
      model,
      mode,
      startedAt: this.clock(),
      prompt: options.prompt,
      toolChoice: options.toolChoice,
      toolNames: (options.tools ?? []).map((t) => t.name),
      toolCallIds: [],
    };
    this.calls.push(record);
    return record;
  }

  end(record: ProviderCallRecord): void {
    if (record.endedAt === undefined) record.endedAt = this.clock();
  }

  /** Take the next scripted step for model call `record`. */
  nextStep(record: ProviderCallRecord): ScriptedStep {
    let step: ScriptedStep;
    if (this.cursor < this.steps.length) {
      step = this.steps[this.cursor++];
    } else if (this.onExhausted) {
      step = this.onExhausted(record.index);
    } else {
      this.exhausted = true;
      step = { kind: 'text', text: 'Script exhausted: no more scripted steps for this turn.' };
    }
    record.step = step;
    if (step.kind === 'tools') {
      step.calls.forEach((tc, i) => {
        const id = `eval-c${record.index}-${i}`;
        record.toolCallIds.push(id);
        this.recorded.set(id, tc);
      });
    }
    return step;
  }

  recordedResult(toolCallId: string): ScriptedToolCall | undefined {
    return this.recorded.get(toolCallId);
  }
}

/** Flatten a V3 prompt to searchable text (system + every message part). */
export function promptText(prompt: LanguageModelV3Prompt): string {
  const out: string[] = [];
  for (const message of prompt) {
    if (typeof message.content === 'string') {
      out.push(`[${message.role}] ${message.content}`);
      continue;
    }
    for (const part of message.content as unknown as Array<Record<string, unknown>>) {
      if (typeof part.text === 'string') out.push(`[${message.role}] ${part.text}`);
      else if (part.type === 'tool-call') out.push(`[${message.role}] tool-call ${String(part.toolName)} ${JSON.stringify(part.input)}`);
      else if (part.type === 'tool-result') out.push(`[${message.role}] tool-result ${String(part.toolName)} ${JSON.stringify(part.output)}`);
    }
  }
  return out.join('\n');
}
