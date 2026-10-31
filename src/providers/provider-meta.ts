import type { ProviderName } from '../utils/config.js';

/**
 * What each model provider is and how to connect it, shared by the terminal
 * setup (`mercury setup` / `doctor`) and the desktop and dashboard Settings,
 * so a key that one rejects the other rejects too.
 */

export type ProviderKind = 'cloud' | 'gateway' | 'local' | 'account';

export interface ProviderMeta {
  label: string;
  /** cloud: a vendor key · gateway: one key, many vendors' models · local: runs on your machine · account: sign-in, not a key. */
  kind: ProviderKind;
  blurb: string;
  needsKey: boolean;
  /** The user must type the base URL (no sensible default). */
  needsBaseUrl: boolean;
  /** Where to get a key. */
  keyUrl?: string;
  /** Example key prefix for the input placeholder. */
  keyHint?: string;
  /** Configured only through `mercury doctor` (OAuth), not with a key. */
  signInOnly?: boolean;
}

export const PROVIDER_META: Record<ProviderName, ProviderMeta> = {
  // First on purpose: the recommended quick start, listed above everything else.
  mercuryCloud: { label: 'Mercury Cloud', kind: 'account', blurb: 'The quick start: sign in and chat. No API keys; models from every major lab on one account.', needsKey: false, needsBaseUrl: false, signInOnly: true },
  aimlapi: { label: 'AI/ML API', kind: 'gateway', blurb: '350+ models from every major lab on one key.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://aimlapi.com/app/keys' },
  openai: { label: 'OpenAI', kind: 'cloud', blurb: 'GPT models. The same key powers voice and voice notes.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://platform.openai.com/api-keys', keyHint: 'sk-…' },
  anthropic: { label: 'Anthropic', kind: 'cloud', blurb: 'Claude models.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://console.anthropic.com/settings/keys', keyHint: 'sk-ant-…' },
  deepseek: { label: 'DeepSeek', kind: 'cloud', blurb: 'DeepSeek chat and reasoning models.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://platform.deepseek.com/api_keys', keyHint: 'sk-…' },
  grok: { label: 'Grok (xAI)', kind: 'cloud', blurb: 'Grok models. The same key powers Grok voice.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://console.x.ai', keyHint: 'xai-…' },
  atlascloud: { label: 'Atlas Cloud', kind: 'gateway', blurb: 'Open models (Qwen, DeepSeek, Llama) on one key.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://www.atlascloud.ai' },
  runcrate: { label: 'Runcrate', kind: 'gateway', blurb: 'Open models (DeepSeek, GLM, Qwen, Kimi) on one key.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://www.runcrate.ai/dashboard/api-keys' },
  ollamaCloud: { label: 'Ollama Cloud', kind: 'cloud', blurb: 'Large open models hosted by Ollama.', needsKey: true, needsBaseUrl: false, keyUrl: 'https://ollama.com/settings/keys' },
  ollamaLocal: { label: 'Ollama (this computer)', kind: 'local', blurb: 'Models you run yourself with Ollama. Free and private.', needsKey: false, needsBaseUrl: false },
  lmStudio: { label: 'LM Studio', kind: 'local', blurb: 'Models served by LM Studio on this computer.', needsKey: false, needsBaseUrl: false },
  atomicChat: { label: 'Atomic Chat', kind: 'local', blurb: 'Models served by Atomic Chat on this computer.', needsKey: false, needsBaseUrl: false },
  litellm: { label: 'LiteLLM proxy', kind: 'gateway', blurb: 'Your own LiteLLM gateway in front of any vendors.', needsKey: false, needsBaseUrl: true },
  openaiCompat: { label: 'OpenAI-compatible', kind: 'gateway', blurb: 'Any endpoint that speaks the OpenAI API (OpenRouter, Together, Groq, vLLM…).', needsKey: false, needsBaseUrl: true },
  mimo: { label: 'MiMo (Xiaomi)', kind: 'cloud', blurb: 'Xiaomi MiMo models.', needsKey: true, needsBaseUrl: false, keyHint: 'sk-…' },
  mimoTokenPlan: { label: 'MiMo Token Plan', kind: 'cloud', blurb: 'Xiaomi MiMo on a token plan.', needsKey: true, needsBaseUrl: false, keyHint: 'tp-…' },
  chatgptWeb: { label: 'ChatGPT Plus/Pro', kind: 'account', blurb: 'Your ChatGPT subscription. Sign in once with `mercury doctor`.', needsKey: false, needsBaseUrl: false, signInOnly: true },
  githubCopilot: { label: 'GitHub Copilot', kind: 'account', blurb: 'Your Copilot subscription. Sign in once with `mercury doctor`.', needsKey: false, needsBaseUrl: false, signInOnly: true },
};

export function looksLikeToken(value: string, minLength: number = 20): boolean {
  return value.length >= minLength && !/\s/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

export function validateApiKey(provider: ProviderName, value: string): string | null {
  if (provider === 'openai') {
    return /^sk-(proj-|svcacct-)?[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'OpenAI keys must start with `sk-`, `sk-proj-`, or `sk-svcacct-`.';
  }

  if (provider === 'anthropic') {
    return /^sk-ant-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'Anthropic keys must start with `sk-ant-`.';
  }

  if (provider === 'deepseek') {
    return /^sk-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'DeepSeek keys must start with `sk-`.';
  }

  if (provider === 'grok') {
    return looksLikeToken(value)
      ? null
      : 'Grok keys must look like a real API token: long, no spaces, and not plain text.';
  }

  if (provider === 'ollamaCloud') {
    return looksLikeToken(value)
      ? null
      : 'Ollama Cloud keys must look like a real API token: long, no spaces, and not plain text.';
  }

  if (provider === 'lmStudio') {
    return null;
  }

  if (provider === 'mimo') {
    return /^sk-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'MiMo keys must start with `sk-`.';
  }

  if (provider === 'mimoTokenPlan') {
    return /^tp-[A-Za-z0-9_-]{16,}$/i.test(value)
      ? null
      : 'MiMo Token Plan keys must start with `tp-`.';
  }

  return null;
}

export function validateBaseUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'Base URL must start with http:// or https://.';
    }
    return null;
  } catch {
    return 'Please enter a valid URL.';
  }
}

export function validateModelName(value: string): string | null {
  if (!value.trim()) return 'Model name is required.';
  if (/\s/.test(value)) return 'Model name cannot contain spaces.';
  return null;
}
