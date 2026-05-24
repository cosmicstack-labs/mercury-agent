import type { AppMode } from './types.js';

export function shouldUseCookedTextInput(mode: AppMode, hasPermissionPrompt: boolean): boolean {
  return !hasPermissionPrompt && (mode === 'chat' || mode === 'coding');
}

export function extractCookedSubmission(chunk: string): string | null {
  if (!/[\r\n]/.test(chunk)) return null;
  return chunk.replace(/[\r\n]+$/, '');
}

export function sanitizePrintableInput(chunk: string): string {
  return chunk
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/\p{C}/gu, '');
}
