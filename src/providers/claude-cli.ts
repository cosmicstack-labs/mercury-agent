/**
 * Claude CLI provider — rides the user's `claude` CLI OAuth session (Claude Max /
 * Claude Pro) instead of requiring an Anthropic API key.
 *
 * Exposes a proper Vercel AI SDK v1 `LanguageModelV1` so it plugs into the
 * agent's `streamText()` / `generateText()` loop the same way `@ai-sdk/anthropic`
 * does.
 *
 * Tool-use limitation: the `claude -p` CLI cannot accept caller-defined tools —
 * it only knows its own built-ins (Bash, Read, Edit, ...). We disable those
 * with `--tools ""` so Claude never executes anything locally. Net effect: this
 * adapter is TEXT-ONLY. If the caller passes `mode.tools`, we surface a warning
 * and proceed without tool calls. Workflows that require tools (Mercury's
 * scheduled skills) need a different provider (anthropic API / openai).
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
} from '@ai-sdk/provider';
import { BaseProvider, type LLMResponse, type LLMStreamChunk } from './base.js';
import type { ProviderConfig } from '../utils/config.js';

interface ClaudeCliEvent {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  is_error?: boolean;
  result?: string;
}

// Flatten AI SDK prompt messages → (system, transcript) for `claude -p`.
// System text goes to --append-system-prompt. Conversation goes on stdin.
function serializePrompt(prompt: LanguageModelV1Prompt): { system: string; userPrompt: string } {
  const systemParts: string[] = [];
  const transcript: string[] = [];

  for (const msg of prompt) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string' && msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'user') {
      const text = msg.content
        .filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('');
      if (text) transcript.push(`User: ${text}`);
      continue;
    }

    if (msg.role === 'assistant') {
      const pieces: string[] = [];
      for (const p of msg.content) {
        if (p.type === 'text') pieces.push((p as { text: string }).text);
        else if (p.type === 'tool-call') {
          const tc = p as { toolName: string; args: unknown };
          pieces.push(`[Tool call: ${tc.toolName} args: ${JSON.stringify(tc.args)}]`);
        }
      }
      const combined = pieces.join('');
      if (combined) transcript.push(`Assistant: ${combined}`);
      continue;
    }

    if (msg.role === 'tool') {
      const res = msg.content
        .map((p) => `[Tool result: ${JSON.stringify((p as { result: unknown }).result)}]`)
        .join('\n');
      if (res) transcript.push(res);
    }
  }

  return {
    system: systemParts.join('\n\n'),
    userPrompt: transcript.join('\n\n'),
  };
}

function buildClaudeArgs(modelId: string, system: string): string[] {
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
    // Disable ALL built-in tools so Claude never acts locally — we only want text back.
    '--tools', '',
  ];
  if (modelId) args.push('--model', modelId);
  if (system) args.push('--append-system-prompt', system);
  return args;
}

function spawnClaude(cliPath: string, args: string[]): ChildProcessWithoutNullStreams {
  return spawn(cliPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
}

function extractAssistantText(ev: ClaudeCliEvent): string {
  if (ev.type !== 'assistant') return '';
  const parts = ev.message?.content ?? [];
  return parts.filter((p) => p.type === 'text' && p.text).map((p) => p.text ?? '').join('');
}

function tokensFromResult(ev: ClaudeCliEvent): { promptTokens: number; completionTokens: number } {
  const u = ev.usage ?? {};
  const promptTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const completionTokens = u.output_tokens ?? 0;
  return { promptTokens, completionTokens };
}

function toolsWarningIfNeeded(options: LanguageModelV1CallOptions): LanguageModelV1CallWarning[] {
  if (options.mode.type === 'regular' && options.mode.tools && options.mode.tools.length > 0) {
    return [{
      type: 'other',
      message: 'claudeCli provider is text-only — tools were ignored. Use `anthropic` (API key) or `openai` for tool-using workflows.',
    }];
  }
  return [];
}

export class ClaudeCliModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly provider = 'claude-cli';
  readonly modelId: string;
  readonly defaultObjectGenerationMode = undefined;
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

  private cliPath: string;

  constructor(options: { modelId: string; cliPath: string }) {
    this.modelId = options.modelId;
    this.cliPath = options.cliPath;
  }

  async doGenerate(options: LanguageModelV1CallOptions) {
    const { system, userPrompt } = serializePrompt(options.prompt);
    const args = buildClaudeArgs(this.modelId, system);
    const warnings = toolsWarningIfNeeded(options);

    const child = spawnClaude(this.cliPath, args);
    options.abortSignal?.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* noop */ } });
    child.stdin.end(userPrompt);

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });

    const exitCode: number = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0) {
      throw new Error(`claude CLI exited ${exitCode}: ${stderr.slice(0, 500)}`);
    }

    let text = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let finishReason: LanguageModelV1FinishReason = 'stop';

    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev: ClaudeCliEvent;
      try { ev = JSON.parse(trimmed); } catch { continue; }

      if (ev.type === 'assistant') {
        text += extractAssistantText(ev);
      } else if (ev.type === 'result') {
        if (ev.is_error) {
          throw new Error(`claude CLI result error: ${ev.result ?? 'unknown'}`);
        }
        ({ promptTokens, completionTokens } = tokensFromResult(ev));
      }
    }

    return {
      text,
      finishReason,
      usage: { promptTokens, completionTokens },
      rawCall: { rawPrompt: userPrompt, rawSettings: { model: this.modelId, system } },
      warnings,
    };
  }

  async doStream(options: LanguageModelV1CallOptions) {
    const { system, userPrompt } = serializePrompt(options.prompt);
    const args = buildClaudeArgs(this.modelId, system);
    const warnings = toolsWarningIfNeeded(options);

    const child = spawnClaude(this.cliPath, args);
    options.abortSignal?.addEventListener('abort', () => { try { child.kill('SIGTERM'); } catch { /* noop */ } });
    child.stdin.end(userPrompt);

    let buffer = '';
    let prevText = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let stderrBuf = '';
    let finishReason: LanguageModelV1FinishReason = 'stop';

    const stream = new ReadableStream<LanguageModelV1StreamPart>({
      start(controller) {
        const consumeLine = (raw: string) => {
          const trimmed = raw.trim();
          if (!trimmed) return;
          let ev: ClaudeCliEvent;
          try { ev = JSON.parse(trimmed); } catch { return; }

          if (ev.type === 'assistant') {
            const full = extractAssistantText(ev);
            if (full.length > prevText.length) {
              controller.enqueue({
                type: 'text-delta',
                textDelta: full.slice(prevText.length),
              });
              prevText = full;
            }
          } else if (ev.type === 'result') {
            if (ev.is_error) {
              controller.enqueue({ type: 'error', error: new Error(`claude CLI: ${ev.result ?? 'unknown'}`) });
              finishReason = 'error';
            }
            ({ promptTokens, completionTokens } = tokensFromResult(ev));
          }
        };

        child.stderr.on('data', (c: Buffer) => { stderrBuf += c.toString('utf8'); });

        child.stdout.on('data', (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) consumeLine(line);
        });

        // 'close' fires after stdio streams have drained — 'exit' can race with pending stdout data.
        child.on('close', (code) => {
          if (buffer.length > 0) {
            consumeLine(buffer);
            buffer = '';
          }
          if (code !== 0 && finishReason !== 'error') {
            controller.enqueue({
              type: 'error',
              error: new Error(`claude CLI exited ${code}: ${stderrBuf.slice(0, 500)}`),
            });
            finishReason = 'error';
          }
          controller.enqueue({
            type: 'finish',
            finishReason,
            usage: { promptTokens, completionTokens },
          });
          controller.close();
        });

        child.on('error', (err) => {
          controller.enqueue({ type: 'error', error: err });
          controller.close();
        });
      },
      cancel() {
        try { child.kill('SIGTERM'); } catch { /* noop */ }
      },
    });

    return {
      stream,
      rawCall: { rawPrompt: userPrompt, rawSettings: { model: this.modelId, system } },
      warnings,
    };
  }
}

export class ClaudeCliProvider extends BaseProvider {
  readonly name = 'claudeCli';
  readonly model: string;
  private cliPath: string;

  constructor(config: ProviderConfig) {
    super(config);
    this.model = config.model;
    this.cliPath = (config.baseUrl && config.baseUrl.trim().length > 0) ? config.baseUrl : 'claude';
  }

  isAvailable(): boolean {
    return true;
  }

  getModelInstance(): LanguageModelV1 {
    return new ClaudeCliModel({ modelId: this.model, cliPath: this.cliPath });
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    const model = this.getModelInstance();
    const result = await model.doGenerate({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
      ],
    });

    return {
      text: result.text ?? '',
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      totalTokens: result.usage.promptTokens + result.usage.completionTokens,
      model: this.model,
      provider: this.name,
    };
  }

  async *streamText(prompt: string, systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    const model = this.getModelInstance();
    const { stream } = await model.doStream({
      inputFormat: 'prompt',
      mode: { type: 'regular' },
      prompt: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: [{ type: 'text' as const, text: prompt }] },
      ],
    });

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.type === 'text-delta') yield { text: value.textDelta, done: false };
        else if (value.type === 'finish') yield { text: '', done: true };
        else if (value.type === 'error') throw value.error;
      }
    } finally {
      reader.releaseLock();
    }
  }
}
