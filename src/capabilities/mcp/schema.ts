import { jsonSchema, type JSONSchema7, type Schema } from 'ai';

export const MAX_SCHEMA_CHARS = 64 * 1024;

export type InputSchemaResult = { schema: Schema<Record<string, unknown>> } | { skip: string };

function hasNonLocalRef(node: unknown, depth = 0): boolean {
  if (depth > 64 || !node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((item) => hasNonLocalRef(item, depth + 1));
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref' && typeof value === 'string' && !value.startsWith('#')) return true;
    if (hasNonLocalRef(value, depth + 1)) return true;
  }
  return false;
}

export function toInputSchema(inputSchema: unknown): InputSchemaResult {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { skip: 'input schema is not an object' };
  }
  const schema = inputSchema as Record<string, unknown>;
  if (schema.type !== 'object') {
    return { skip: `input schema type is ${JSON.stringify(schema.type ?? null)}, expected "object"` };
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    return { skip: 'input schema cannot be serialized' };
  }
  if (serialized.length > MAX_SCHEMA_CHARS) {
    return { skip: `input schema is ${serialized.length} characters, over the ${MAX_SCHEMA_CHARS} limit` };
  }
  if (hasNonLocalRef(schema)) {
    return { skip: 'input schema uses a non-local $ref' };
  }
  return { schema: jsonSchema<Record<string, unknown>>(schema as JSONSchema7) };
}
