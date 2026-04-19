# Mercury — Research

> Experiments, findings, and notes.

## Token Optimization

### 2026-04-19: Baseline Token Costs

| Component | Est. Tokens |
|---|---|
| soul.md | ~200 |
| persona.md | ~150 |
| taste.md | ~100 |
| heartbeat.md | ~100 |
| Short-term (10 msgs) | ~500 |
| Long-term facts (3) | ~100 |
| User message | ~100 |
| Agent response | ~500 |
| **Total per request** | **~1,200-1,500** |

### Strategies
1. Only inject soul+persona by default (~350 tokens)
2. Taste and heartbeat loaded selectively
3. Compress old conversation into 50-token summaries
4. Keyword matching for long-term retrieval (not full scan)
5. Daily token budget with hard cap

## Telegram Streaming

- Telegram supports streaming via `sendMessageDraft` API (Bot API 9.5+)
- grammY's `@grammyjs/stream` plugin handles this natively
- Streaming only works in private chats
- Must use `@grammyjs/auto-retry` alongside stream plugin (flood limits)
- Markdown partial chunks break Telegram's parser — stream plain text, edit with formatting after

## LLM Provider Notes

- DeepSeek uses OpenAI-compatible API — same adapter works
- Vercel AI SDK `createOpenAI` accepts custom `baseURL` — works for any OpenAI-compatible endpoint
- Token counting: `js-tiktoken` for OpenAI tokenization. Anthropic uses different tokenizer — approximate.