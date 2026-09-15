import { generateText, stepCountIs } from 'ai';
import type { Tool } from 'ai';
import type { CapabilityRegistry } from '../capabilities/registry.js';
import type { UserMemoryStore } from '../memory/user-memory.js';
import type { TokenBudget } from '../utils/tokens.js';
import type { BaseProvider } from '../providers/base.js';
import { classifyStreamCompletion } from '../core/stream-completion.js';
import { logger } from '../utils/logger.js';
import type { BotManifest, BotTrigger } from './types.js';

/** Mailbox messages injected mid-turn (bot-to-bot or queued user input). */
export interface BotTurnMail {
  from: string;
  content: string;
}

export interface BotTurnInput {
  manifest: BotManifest;
  trigger: BotTrigger;
  prompt: string;
  persona: string;
  /** Pending mailbox messages at turn start (attributed bot-to-bot handoffs). */
  mail: BotTurnMail[];
  /** Callback checked between rounds for newly arrived mailbox messages. */
  pollMail: () => BotTurnMail[];
  capabilities: CapabilityRegistry;
  tools: Record<string, Tool>;
  userMemory: UserMemoryStore | null;
  provider: BaseProvider;
  tokenBudget: TokenBudget;
  abortSignal: AbortSignal;
}

export interface BotTurnOutput {
  status: 'completed' | 'failed' | 'halted' | 'paused';
  output: string;
  tokensIn: number;
  tokensOut: number;
  error?: string;
  reasonCode?: string;
}

const MAX_STEPS_DEFAULT = 25;

/**
 * One run of one bot: a fresh-context tool loop over the bot's own provider,
 * persona, toolset, memory namespace, and fail-closed permission manager.
 * Structurally mirrors SubAgent.run() minus the shared-registry hazards:
 * every dependency here is already per-bot.
 */
export async function runBotTurn(input: BotTurnInput): Promise<BotTurnOutput> {
  const { manifest, provider, capabilities, tools, tokenBudget, abortSignal } = input;
  const maxSteps = manifest.autonomy?.maxSteps ?? MAX_STEPS_DEFAULT;

  const system = buildBotSystemPrompt(input);
  const messages: any[] = [];

  for (const m of input.mail) {
    messages.push({ role: 'user', content: `Message from 🤖 ${m.from}:\n\n${m.content}` });
  }
  if (input.prompt) {
    messages.push({ role: 'user', content: input.prompt });
  }
  if (messages.length === 0) {
    messages.push({ role: 'user', content: 'You have no specific task. Check your inbox and report your status.' });
  }

  let tokensIn = 0;
  let tokensOut = 0;
  let lastResult: any = null;
  let stepsRemaining = maxSteps;

  try {
    while (stepsRemaining > 0 && !abortSignal.aborted) {
      const result = await generateText({
        model: provider.getModelInstance(),
        system,
        messages,
        tools,
        stopWhen: stepCountIs(stepsRemaining),
        abortSignal,
        experimental_include: { requestBody: false, responseBody: false },
        onStepFinish: ({ usage }) => {
          if (abortSignal.aborted) return;
          stepsRemaining--;
          if (usage) {
            tokensIn += usage.inputTokens ?? 0;
            tokensOut += usage.outputTokens ?? 0;
          }
        },
      });
      lastResult = result;

      const completion = classifyStreamCompletion({
        finishReason: (result as any)?.finishReason,
        hasText: Boolean(result?.text),
        hasToolCalls: true,
      });
      if (completion === 'interrupted') {
        throw new Error('Generation was interrupted before completion (no finish signal from provider)');
      }

      if (result.text) {
        messages.push({ role: 'assistant', content: result.text });
      }

      // Consume newly arrived mailbox messages before finishing, so a
      // handoff delivered mid-turn is not lost to the next scheduling gap.
      if (!abortSignal.aborted && stepsRemaining > 0) {
        const fresh = input.pollMail();
        if (fresh.length > 0) {
          for (const m of fresh) {
            messages.push({ role: 'user', content: `Message from 🤖 ${m.from}:\n\n${m.content}` });
          }
          continue;
        }
      }
      break;
    }

    if (abortSignal.aborted) {
      return { status: 'halted', output: 'Turn was halted.', tokensIn, tokensOut };
    }

    // Step budget exhausted with tool calls still pending — pause, never
    // report success on half-done work (sub-agent completion contract).
    if (stepsRemaining <= 0 && (lastResult as any)?.finishReason === 'tool-calls') {
      return {
        status: 'paused',
        output: 'Step budget reached before the turn completed — remaining work continues next turn.',
        tokensIn,
        tokensOut,
        reasonCode: 'step_budget',
      };
    }

    const output = (lastResult?.text || '').trim() || '(no text response)';

    tokenBudget.recordUsage({
      provider: provider.name,
      model: provider.getModel(),
      inputTokens: tokensIn,
      outputTokens: tokensOut,
      totalTokens: tokensIn + tokensOut,
      channelType: 'bot',
    });

    return { status: 'completed', output, tokensIn, tokensOut };
  } catch (err: any) {
    if (abortSignal.aborted) {
      return { status: 'halted', output: 'Turn was halted.', tokensIn, tokensOut };
    }
    return {
      status: 'failed',
      output: `Turn failed: ${err?.message ?? String(err)}`,
      tokensIn,
      tokensOut,
      error: err?.message ?? String(err),
      reasonCode: classifyFailure(err),
    };
  }
}

/** Map a provider/tool error to a typed reason code (retry vs permanent). */
export function classifyFailure(err: any): string {
  const msg = String(err?.message ?? err ?? '').toLowerCase();
  if (/rate.?limit|429|too many requests/.test(msg)) return 'provider_rate_limit';
  if (/timeout|etimedout|econnaborted|socket hang up/.test(msg)) return 'provider_timeout';
  if (/permission denied|blocked command|no permission/.test(msg)) return 'permission_denied';
  if (/api key|unauthorized|401|authentication/.test(msg)) return 'provider_auth';
  if (/quota|billing|402/.test(msg)) return 'provider_quota';
  if (/context|maximum.*tokens|too long/.test(msg)) return 'context_overflow';
  return 'unknown_error';
}

/** Transient failures may retry; permanent ones go straight to the DLQ. */
export function isTransientFailure(reasonCode: string): boolean {
  return reasonCode === 'provider_rate_limit' || reasonCode === 'provider_timeout';
}

function buildBotSystemPrompt(input: BotTurnInput): string {
  const { manifest } = input;
  let prompt = `You are "${manifest.name}", a Mercury bot (id: ${manifest.id}).\n`;
  if (manifest.description) {
    prompt += `Role: ${manifest.description}\n`;
  }
  prompt += '\n';
  prompt += input.persona;

  // Scoped memory injection — mirrors the main agent's injection site, but
  // into the bot's own namespace (scope own/shared-read; scope none = null).
  if (input.userMemory) {
    try {
      const query = input.mail.map(m => m.content).join(' ') || input.prompt;
      const relevant = input.userMemory.retrieveRelevant(query, { maxRecords: 5, maxChars: 900 });
      if (relevant?.context) {
        prompt += `\n\n[Bot memory — auto-retrieved context]\n${relevant.context}`;
      }
    } catch (err: any) {
      logger.warn({ botId: manifest.id, err: err?.message }, 'Bot memory retrieval failed — continuing without');
    }
  }

  prompt += `\n\nOperating rules:
- You run unattended: NEVER ask the user questions or wait for confirmation. If a required input is missing, state the assumption you are proceeding with.
- Actions you lack permission for are denied automatically (fail-closed). Do not attempt workarounds; report what you could not do.
- Stay in your specialty; say so plainly when a request falls outside it.`;

  const roster = manifest.comms?.canMessage ?? [];
  if (roster.length > 0) {
    prompt += `\n\nBots you can message via bot_send: ${roster.join(', ')}.`;
  }

  const toolNames = Object.keys(input.tools);
  if (toolNames.length > 0) {
    prompt += `\n\nAvailable tools: ${toolNames.join(', ')}`;
  }

  const remaining = input.tokenBudget.getRemaining();
  prompt += `\n\nToken budget remaining: ${remaining}`;

  return prompt;
}