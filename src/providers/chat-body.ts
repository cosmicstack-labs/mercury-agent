/**
 * Request-body fixes for OpenAI-compatible Chat Completions servers that
 * render the model's own chat template (Ollama 0.40.6+, llama.cpp, LM Studio,
 * vLLM). Qwen-family templates reject any system message that isn't the very
 * first message ("System message must be at the beginning."), and Mercury
 * sends two: the cached system prompt, then the per-turn context block.
 */

type ChatMessage = { role?: unknown; content?: unknown; [key: string]: unknown };

/** Providers served by self-hosted engines that apply strict chat templates. */
const STRICT_TEMPLATE_PROVIDERS = new Set(['ollamaLocal', 'ollamaCloud', 'lmStudio', 'atomicChat', 'openaiCompat', 'litellm']);

export function needsSystemMessageFixup(provider: string): boolean {
  return STRICT_TEMPLATE_PROVIDERS.has(provider);
}

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && content.every((p) => p && typeof p === 'object' && (p as { type?: unknown }).type === 'text')) {
    return content.map((p) => String((p as { text?: unknown }).text ?? '')).join('');
  }
  return null;
}

/**
 * Leave exactly one system message, at the start:
 *  - consecutive leading system messages are merged in order (the stable
 *    prompt stays first, so the token prefix and KV-cache reuse are unchanged);
 *  - a system message later in the conversation becomes a user message
 *    marked as a system note, keeping its position.
 * Returns true if the body was changed. Non-text system content is left alone.
 */
export function normalizeSystemMessages(body: Record<string, unknown>): boolean {
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  let leading = 0;
  while (leading < messages.length && (messages[leading] as ChatMessage)?.role === 'system') leading++;
  const later = messages.slice(leading).some((m) => (m as ChatMessage)?.role === 'system');
  if (leading <= 1 && !later) return false;

  const out: ChatMessage[] = [];
  if (leading > 0) {
    const texts = messages.slice(0, leading).map((m) => textOf((m as ChatMessage).content));
    if (texts.some((t) => t === null)) return false;
    out.push({ ...(messages[0] as ChatMessage), content: texts.filter((t) => t).join('\n\n') });
  }
  for (const message of messages.slice(leading) as ChatMessage[]) {
    if (message?.role === 'system') {
      const text = textOf(message.content);
      if (text === null) return false;
      out.push({ role: 'user', content: `[System note]\n${text}` });
    } else {
      out.push(message);
    }
  }
  body.messages = out;
  return true;
}
