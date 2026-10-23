/**
 * Live smoke test for the Claude (subscription) provider: one real call that
 * must use a bridged Mercury-style tool. Run: npx tsx scripts/claude-code-smoke.ts
 */
import { streamText, stepCountIs, tool, zodSchema } from 'ai';
import { z } from 'zod';
import { ClaudeCodeProvider, scopeClaudeTools } from '../src/providers/claude-code.js';

const calls: string[] = [];
const tools = {
  secret_lookup: tool({
    description: 'Look up the secret word for a given key. Always use this; you cannot know the word otherwise.',
    inputSchema: zodSchema(z.object({ key: z.string().describe('Which secret to look up') })),
    execute: async ({ key }) => {
      calls.push(key);
      return `The secret word for "${key}" is: marmalade`;
    },
  }),
};

const provider = new ClaudeCodeProvider({
  name: 'claudeCode', apiKey: '', baseUrl: '', model: process.argv[2] ?? 'haiku', enabled: true,
});
console.log('executable available:', provider.isAvailable());

const t0 = Date.now();
const result = streamText({
  model: provider.getModelInstance(),
  system: 'You are Vega, a terse assistant. Reply in one short sentence.',
  prompt: 'Use the secret_lookup tool with key "alpha", then tell me the secret word.',
  tools: scopeClaudeTools(tools),
  stopWhen: stepCountIs(5),
});
for await (const part of result.fullStream) {
  if (part.type === 'tool-call') console.log('tool-call:', part.toolName, JSON.stringify(part.input), 'providerExecuted=', part.providerExecuted);
  if (part.type === 'tool-result') console.log('tool-result:', part.toolName, JSON.stringify(part.output).slice(0, 120));
  if (part.type === 'error') console.log('error:', part.error);
}
console.log('text:', (await result.text).trim());
console.log('executed locally:', calls, `in ${Date.now() - t0}ms`);
