import { describe, expect, it } from 'vitest';
import { MAX_SCHEMA_CHARS, toInputSchema } from './schema.js';

describe('toInputSchema', () => {
  it('accepts object schemas, including local refs', () => {
    const result = toInputSchema({
      type: 'object',
      properties: { q: { $ref: '#/$defs/query' } },
      $defs: { query: { type: 'string' } },
    });
    expect('schema' in result).toBe(true);
  });

  it('skips non-object roots with a reason', () => {
    expect(toInputSchema({ type: 'string' })).toEqual({ skip: 'input schema type is "string", expected "object"' });
    expect(toInputSchema(undefined)).toEqual({ skip: 'input schema is not an object' });
    expect(toInputSchema([])).toEqual({ skip: 'input schema is not an object' });
  });

  it('skips oversized schemas', () => {
    const result = toInputSchema({ type: 'object', description: 'x'.repeat(MAX_SCHEMA_CHARS) });
    expect('skip' in result && result.skip).toMatch(/over the \d+ limit/);
  });

  it('skips schemas with remote refs', () => {
    const result = toInputSchema({ type: 'object', properties: { a: { $ref: 'https://example.com/a.json' } } });
    expect(result).toEqual({ skip: 'input schema uses a non-local $ref' });
  });
});
