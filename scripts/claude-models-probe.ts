/**
 * Print the models the signed-in Claude Code account offers, via the Agent
 * SDK's supportedModels() (no prompt is sent). Run: npx tsx scripts/claude-models-probe.ts
 */
import { listClaudeModels } from '../src/providers/claude-code.js';

const t0 = Date.now();
const models = await listClaudeModels();
console.log(`${models.length} models in ${Date.now() - t0}ms`);
for (const m of models) {
  console.log(JSON.stringify(m));
}
