import { redactSecrets } from '../../utils/redact.js';

export const MAX_RESULT_CHARS = 32 * 1024;

interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; blob?: string; mimeType?: string };
}

export interface McpCallResultLike {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

function base64Bytes(data: string | undefined): number {
  if (!data) return 0;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return block.text ?? '';
    case 'image':
    case 'audio':
      return `[${block.mimeType ?? block.type}, ${formatBytes(base64Bytes(block.data))} — not shown]`;
    case 'resource': {
      const resource = block.resource ?? {};
      if (typeof resource.text === 'string') return resource.text;
      return `[resource ${resource.uri ?? ''} (${resource.mimeType ?? 'binary'}) — not shown]`;
    }
    case 'resource_link':
      return `[resource link: ${block.uri ?? block.name ?? ''}]`;
    default:
      return `[${block.type ?? 'unknown'} content — not shown]`;
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const omitted = text.length - MAX_RESULT_CHARS;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated, ${omitted} chars omitted)`;
}

export function callResultToText(result: McpCallResultLike): string {
  const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  let text = blocks.map(blockToText).filter((part) => part.length > 0).join('\n');
  if (!text && result.structuredContent !== undefined) {
    text = JSON.stringify(result.structuredContent, null, 2) ?? '';
  }
  if (!text) {
    text = result.isError ? 'the server reported an error without details' : '(no content)';
  }
  if (result.isError) text = `Error: ${text}`;
  return truncate(redactSecrets(text));
}
