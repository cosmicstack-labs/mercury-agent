/**
 * ScriptedProvider — a real BaseProvider whose model instance is a
 * MockLanguageModelV3 playing back the fixture's steps through the
 * ScriptPlayer. The agent loop cannot tell it from a live provider: it goes
 * through ProviderRegistry, the fallback iterator, streamText/generateText,
 * tool-call parsing and the SDK's multi-step loop exactly as in production.
 */
import { MockLanguageModelV3 } from 'ai/test';
import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from '@ai-sdk/provider';
import { BaseProvider, type LLMResponse, type LLMStreamChunk } from '../providers/base.js';
import { DEFAULT_USAGE, type ScriptedProviderSpec, type ScriptedStep, type ScriptedUsage } from './fixture.js';
import type { ScriptPlayer } from './script-player.js';

function toUsage(usage: ScriptedUsage | undefined): LanguageModelV3Usage {
  const input = usage?.inputTokens ?? DEFAULT_USAGE.inputTokens;
  const output = usage?.outputTokens ?? DEFAULT_USAGE.outputTokens;
  const cached = usage?.cachedInputTokens ?? DEFAULT_USAGE.cachedInputTokens;
  return {
    inputTokens: { total: input, noCache: input - cached, cacheRead: cached, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function finishOf(step: ScriptedStep): LanguageModelV3FinishReason {
  if (step.kind === 'tools') return { unified: 'tool-calls', raw: 'tool_use' };
  return step.finishReason === 'length' ? { unified: 'length', raw: 'max_tokens' } : { unified: 'stop', raw: 'end_turn' };
}

function contentOf(step: ScriptedStep, toolCallIds: string[]): LanguageModelV3Content[] {
  const content: LanguageModelV3Content[] = [];
  if (step.text) content.push({ type: 'text', text: step.text });
  if (step.kind === 'tools') {
    step.calls.forEach((tc, i) => {
      content.push({ type: 'tool-call', toolCallId: toolCallIds[i], toolName: tc.tool, input: JSON.stringify(tc.input) });
    });
  }
  return content;
}

export class ScriptedProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  /** Model calls this provider received (including failed ones). */
  callCount = 0;
  private readonly failFirst: number;
  private readonly failWith: string;
  private readonly instance: MockLanguageModelV3;

  constructor(spec: ScriptedProviderSpec, private readonly player: ScriptPlayer) {
    const model = spec.model ?? `${spec.name}-model`;
    super({ name: spec.name, apiKey: 'eval', baseUrl: 'eval://', model, enabled: true });
    this.name = spec.name;
    this.model = model;
    this.failFirst = spec.failFirst ?? 0;
    this.failWith = spec.failWith ?? `${spec.name}: scripted outage (503 Service Unavailable)`;
    this.instance = new MockLanguageModelV3({
      provider: `eval.${spec.name}`,
      modelId: model,
      doStream: async (options) => this.doStream(options),
      doGenerate: async (options) => this.doGenerate(options),
    });
  }

  private maybeFail(options: LanguageModelV3CallOptions, mode: 'stream' | 'generate'): ReturnType<ScriptPlayer['begin']> {
    this.callCount++;
    const record = this.player.begin(this.name, this.model, mode, options);
    if (this.callCount <= this.failFirst) {
      record.error = this.failWith;
      this.player.end(record);
      throw new Error(this.failWith);
    }
    return record;
  }

  private async doStream(options: LanguageModelV3CallOptions) {
    const record = this.maybeFail(options, 'stream');
    const step = this.player.nextStep(record);
    const parts: LanguageModelV3StreamPart[] = [{ type: 'stream-start', warnings: [] }];
    if (step.text) {
      parts.push({ type: 'text-start', id: 't0' });
      parts.push({ type: 'text-delta', id: 't0', delta: step.text });
      parts.push({ type: 'text-end', id: 't0' });
    }
    for (const part of contentOf(step, record.toolCallIds)) {
      if (part.type === 'tool-call') parts.push(part);
    }
    parts.push({ type: 'finish', usage: toUsage(step.usage), finishReason: finishOf(step) });
    const player = this.player;
    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
        player.end(record);
      },
    });
    return { stream };
  }

  private async doGenerate(options: LanguageModelV3CallOptions) {
    const record = this.maybeFail(options, 'generate');
    const step = this.player.nextStep(record);
    this.player.end(record);
    return {
      content: contentOf(step, record.toolCallIds),
      finishReason: finishOf(step),
      usage: toUsage(step.usage),
      warnings: [],
    };
  }

  getModelInstance(): MockLanguageModelV3 {
    return this.instance;
  }

  isAvailable(): boolean {
    return true;
  }

  // The direct helpers are only used by side paths (session titles, status
  // verbs); the eval never scripts them, so they answer deterministically.
  async generateText(): Promise<LLMResponse> {
    return { text: 'Eval', inputTokens: 0, outputTokens: 0, totalTokens: 0, model: this.model, provider: this.name };
  }

  async *streamText(): AsyncIterable<LLMStreamChunk> {
    yield { text: 'Eval', done: true };
  }
}
