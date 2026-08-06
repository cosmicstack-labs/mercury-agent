import type { BaseProvider } from '../providers/base.js';
import { DeepSeekProvider } from '../providers/deepseek.js';

export function getReasoningProviderOptions(provider: BaseProvider): { deepseek: { thinking: { type: 'enabled' } } } | undefined {
  const model = (provider.getModel?.() || '').toLowerCase();
  const name = (provider.name || '').toLowerCase();
  const baseUrl = ((provider as any).config?.baseUrl || '').toLowerCase();

  if (provider instanceof DeepSeekProvider && provider.isReasoner) {
    return { deepseek: { thinking: { type: 'enabled' } } };
  }

  const looksLikeDeepSeekReasoningModel =
    model.includes('deepseek-reasoner') ||
    model.includes('deepseek-r1') ||
    model.includes('deepseek-v3.1');

  const routedToDeepSeek =
    name === 'deepseek' ||
    baseUrl.includes('deepseek.com');

  if (looksLikeDeepSeekReasoningModel && routedToDeepSeek) {
    return { deepseek: { thinking: { type: 'enabled' } } };
  }

  return undefined;
}
