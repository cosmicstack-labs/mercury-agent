import { jsonSchema, type JSONSchema7, type Schema } from 'ai';

/**
 * A tool's input schema is server-supplied text the model reads on every
 * turn: a prompt-injection and context-flood surface (ADR-029). Each
 * description inside it is capped, and the whole schema must fit 16 KB.
 */
export const MAX_SCHEMA_CHARS = 16 * 1024;
export const MAX_SCHEMA_DESCRIPTION_CHARS = 300;

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

/** A copy with every `description` and `title` string shortened. */
function capDescriptions(node: unknown, depth = 0): unknown {
  if (depth > 64 || !node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((item) => capDescriptions(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if ((key === 'description' || key === 'title') && typeof value === 'string' && value.length > MAX_SCHEMA_DESCRIPTION_CHARS) {
      out[key] = `${value.slice(0, MAX_SCHEMA_DESCRIPTION_CHARS)}…`;
    } else {
      out[key] = capDescriptions(value, depth + 1);
    }
  }
  return out;
}

export function toInputSchema(inputSchema: unknown): InputSchemaResult {
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    return { skip: 'input schema is not an object' };
  }
  const schema = capDescriptions(inputSchema) as Record<string, unknown>;
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
