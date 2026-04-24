import { createOpenAI } from '@ai-sdk/openai';
import { generateText, streamText } from 'ai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { logger } from '../utils/logger.js';

interface ReasoningEntry {
  reasoning: string;
}

const MAX_STORE_SIZE = 50;

export class DeepSeekProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private client: ReturnType<typeof createOpenAI>;
  private modelInstance: ReturnType<ReturnType<typeof createOpenAI>['languageModel']>;
  private reasoningByText = new Map<string, ReasoningEntry>();
  private reasoningByToolCalls = new Map<string, ReasoningEntry>();

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;

    const self = this;
    const originalFetch = globalThis.fetch.bind(globalThis);

    this.client = createOpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        // --- Request interception: inject reasoning into assistant messages ---
        if (init?.body && typeof init.body === 'string') {
          try {
            const body = JSON.parse(init.body);
            if (body.messages && Array.isArray(body.messages)) {
              let modified = false;
              for (const msg of body.messages) {
                if (msg.role === 'assistant' && !msg.reasoning_content) {
                  const reasoning = self.findReasoning(msg);
                  if (reasoning) {
                    msg.reasoning_content = reasoning;
                    modified = true;
                  }
                }
              }
              if (modified) {
                init = { ...init, body: JSON.stringify(body) };
              }
            }
          } catch {
            // Send as-is if parsing fails
          }
        }

        // --- Make the actual request ---
        const response = await originalFetch(url, init);

        if (!response.ok) return response;

        const contentType = response.headers.get('content-type') ?? '';

        // --- Response interception ---
        if (contentType.includes('text/event-stream')) {
          return self.interceptStream(response);
        }

        return self.interceptJson(response);
      },
    });

    this.modelInstance = this.client(config.model);
  }

  private findReasoning(msg: Record<string, any>): string | null {
    const content = (msg.content ?? '').trim();

    // Match by text content
    if (content) {
      const entry = this.reasoningByText.get(content);
      if (entry) return entry.reasoning;
    }

    // Fallback: match by tool_calls signature (for responses with no text, only tool_calls)
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      const sig = msg.tool_calls
        .map((tc: Record<string, any>) => tc.function?.name ?? '')
        .filter(Boolean)
        .join(',');
      if (sig) {
        const entry = this.reasoningByToolCalls.get(sig);
        if (entry) return entry.reasoning;
      }
    }

    return null;
  }

  private storeReasoning(textContent: string, toolCallsSignature: string, reasoning: string): void {
    if (!reasoning) return;

    if (this.reasoningByText.size > MAX_STORE_SIZE) {
      this.reasoningByText.clear();
      this.reasoningByToolCalls.clear();
    }

    if (textContent) {
      this.reasoningByText.set(textContent, { reasoning });
    }
    if (toolCallsSignature) {
      this.reasoningByToolCalls.set(toolCallsSignature, { reasoning });
    }
  }

  private interceptJson(response: Response): Response {
    const clone = response.clone();

    clone
      .json()
      .then((json: any) => {
        const reasoning: string | undefined =
          json.choices?.[0]?.message?.reasoning_content;
        const content: string = json.choices?.[0]?.message?.content ?? '';
        const toolCalls: Array<Record<string, any>> | undefined =
          json.choices?.[0]?.message?.tool_calls;
        const toolCallsSignature = toolCalls
          ?.map((tc: any) => tc.function?.name ?? '')
          .filter(Boolean)
          .join(',') ?? '';

        if (reasoning) {
          this.storeReasoning(content.trim(), toolCallsSignature, reasoning);
          logger.debug(
            { contentLen: content.length, reasoningLen: reasoning.length },
            'DeepSeek: captured reasoning from JSON response',
          );
        }
      })
      .catch(() => {
        // Ignore parse errors
      });

    return response;
  }

  private interceptStream(response: Response): Response {
    const self = this;
    let accumulatedReasoning = '';
    let accumulatedText = '';
    let accumulatedToolCallNames: string[] = [];
    let buffer = '';

    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        // Pass through the raw bytes unchanged
        controller.enqueue(chunk);

        // Decode and parse SSE lines to capture reasoning
        buffer += new TextDecoder().decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (delta?.reasoning_content) {
              accumulatedReasoning += delta.reasoning_content;
            }
            if (delta?.content) {
              accumulatedText += delta.content;
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.function?.name) {
                  accumulatedToolCallNames.push(tc.function.name);
                }
              }
            }
            // Store when this choice finishes
            if (json.choices?.[0]?.finish_reason && accumulatedReasoning) {
              const toolCallsSignature = accumulatedToolCallNames.join(',');
              self.storeReasoning(
                accumulatedText.trim(),
                toolCallsSignature,
                accumulatedReasoning,
              );
              logger.debug(
                {
                  contentLen: accumulatedText.length,
                  reasoningLen: accumulatedReasoning.length,
                  toolCalls: toolCallsSignature,
                },
                'DeepSeek: captured reasoning from stream',
              );
              // Reset accumulators for potential next choice in the same stream
              accumulatedReasoning = '';
              accumulatedText = '';
              accumulatedToolCallNames = [];
            }
          } catch {
            // Ignore parse errors for partial data
          }
        }
      },
    });

    return new Response(response.body!.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async generateText(prompt: string, systemPrompt: string): Promise<LLMResponse> {
    const result = await generateText({
      model: this.modelInstance,
      system: systemPrompt,
      prompt,
    });

    return {
      text: result.text,
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
      totalTokens:
        (result.usage?.promptTokens ?? 0) +
        (result.usage?.completionTokens ?? 0),
      model: this.model,
      provider: this.name,
    };
  }

  async *streamText(
    prompt: string,
    systemPrompt: string,
  ): AsyncIterable<LLMStreamChunk> {
    const result = streamText({
      model: this.modelInstance,
      system: systemPrompt,
      prompt,
    });

    for await (const chunk of (await result).textStream) {
      yield { text: chunk, done: false };
    }
    yield { text: '', done: true };
  }

  isAvailable(): boolean {
    return this.config.apiKey.length > 0;
  }

  getModelInstance() {
    return this.modelInstance;
  }
}
