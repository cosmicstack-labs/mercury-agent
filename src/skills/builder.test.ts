import { describe, expect, it, vi } from 'vitest';
import { buildSkillDraft, draftProblem, parseDraft } from './builder.js';

const good = {
  name: 'Weekly Sales Report',
  description: 'Builds the weekly sales report from the shared sheet as a PDF for the owner.',
  intents: ['make the weekly sales report', 'sales report for this week'],
  instructions: '1. Ask the owner which week (default: last full week).\n2. Read the sales sheet with the sheets tool.\n3. Total revenue per product and compare with the previous week.\n4. Write the summary and a table, then export a PDF.\n5. Open the PDF to check it has every product and the totals match the sheet.\n6. Send the PDF and a two-line summary.',
  allowedTools: ['read_file', 'not_a_real_tool'],
};

const provider = (...replies: string[]) => {
  const generateText = vi.fn();
  for (const r of replies) generateText.mockResolvedValueOnce({ text: r });
  return { p: { generateText, getModel: () => 'test-model' } as never, generateText };
};

describe('skill builder', () => {
  it('reads a draft even with chatter and fences around it, and drops tools that do not exist', () => {
    const d = parseDraft('Sure!\n```json\n' + JSON.stringify(good) + '\n```', ['read_file', 'web_search']);
    expect(d.name).toBe('weekly-sales-report');
    expect(d.allowedTools).toEqual(['read_file']);
    expect(draftProblem(d)).toBeNull();
  });

  it('a reply with no skill in it is a clear error', () => {
    expect(() => parseDraft('I cannot help with that.', [])).toThrow(/didn't return a skill/);
  });

  it('fixes a draft that breaks the rules with one automatic retry', async () => {
    const { p, generateText } = provider(JSON.stringify({ ...good, instructions: 'Do the report.' }), JSON.stringify(good));
    const r = await buildSkillDraft(p, 'a weekly sales report from my sheet', ['read_file']);
    expect(r.problem).toBeNull();
    expect(r.draft.instructions).toContain('1. Ask the owner');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(generateText.mock.calls[1][0]).toMatch(/Fix this: instructions are too short/);
  });

  it('asks for changes in the owner\'s words', async () => {
    const { p, generateText } = provider(JSON.stringify(good));
    await buildSkillDraft(p, 'sales report', ['read_file'], { draft: parseDraft(JSON.stringify(good), ['read_file']), feedback: 'also email it to finance' });
    expect(generateText.mock.calls[0][0]).toContain('Change it like this: also email it to finance');
  });
});
