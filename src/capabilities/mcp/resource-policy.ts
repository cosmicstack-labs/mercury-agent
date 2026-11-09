import type { McpServerConfig } from './types.js';

export const MAX_RESOURCE_URI_CHARS = 2048;
// URI labels must not contain control characters or whitespace in approval prompts.
// eslint-disable-next-line no-control-regex
export const RESOURCE_URI_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:[^\s\u0000-\u001f\u007f]+$/;

export function isResourceUri(uri: string): boolean {
  return uri.length <= MAX_RESOURCE_URI_CHARS && RESOURCE_URI_PATTERN.test(uri);
}

export function resourcesEnabled(config: McpServerConfig): boolean {
  return !!config.resources?.allow?.length;
}

export function isResourceAllowed(config: McpServerConfig, uri: string): boolean {
  if (!isResourceUri(uri)) return false;
  const filter = config.resources;
  if (filter?.deny?.includes('*') || filter?.deny?.includes(uri)) return false;
  return filter?.allow?.includes('*') === true || filter?.allow?.includes(uri) === true;
}

export function isResourceAutoApproved(config: McpServerConfig, uri: string): boolean {
  return isResourceAllowed(config, uri) && config.resources?.autoApprove?.includes(uri) === true;
}
