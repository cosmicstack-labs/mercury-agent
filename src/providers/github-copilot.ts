import { createOpenAI } from '@ai-sdk/openai';
import { BaseProvider } from './base.js';
import type { ProviderConfig } from '../utils/config.js';
import type { LLMResponse, LLMStreamChunk } from './base.js';
import { getGitHubSession } from '../auth/github-auth.js';
import {
  getValidCopilotToken,
  COPILOT_HEADERS,
  type CopilotToken,
} from '../auth/github-session.js';
import { logger } from '../utils/logger.js';

export class GitHubCopilotProvider extends BaseProvider {
  readonly name: string;
  readonly model: string;
  private cachedModelInstance: any = null;
  private cachedEndpoint: string = '';
  private cachedToken: string = '';

  constructor(config: ProviderConfig) {
    super(config);
    this.name = config.name;
    this.model = config.model;
  }

  async generateText(_prompt: string, _systemPrompt: string): Promise<LLMResponse> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  async *streamText(_prompt: string, _systemPrompt: string): AsyncIterable<LLMStreamChunk> {
    throw new Error('Use getModelInstance() with the AI SDK agent loop');
  }

  isAvailable(): boolean {
    const session = getGitHubSession();
    return session !== null && session.accessToken.length > 0;
  }

  getModelInstance(): any {
    // We need to rebuild the instance when the copilot token refreshes.
    // Since getModelInstance is sync, we eagerly build with the last known
    // copilot token and rely on the custom fetch to refresh it on-the-fly.
    //
    // On first call, we kick off an async token fetch (best-effort) and
    // build a placeholder that will be replaced on next call.
    this._refreshTokenBackground();
    return this._buildModelInstance();
  }

  private _pendingRefresh: Promise<CopilotToken | null> | null = null;
  private _lastCopilotToken: CopilotToken | null = null;

  private _refreshTokenBackground(): void {
    if (this._pendingRefresh) return;
    // Check if we need a refresh
    const now = Date.now() / 1000;
    if (this._lastCopilotToken && this._lastCopilotToken.expiresAt > now + 60) return;

    this._pendingRefresh = getValidCopilotToken()
      .then((t) => {
        this._lastCopilotToken = t;
        this._pendingRefresh = null;
        return t;
      })
      .catch(() => {
        this._pendingRefresh = null;
        return null;
      });
  }

  private _buildModelInstance(): any {
    const copilot = this._lastCopilotToken;
    const endpoint = copilot?.apiEndpoint ?? 'https://api.githubcopilot.com';
    const token = copilot?.token ?? 'pending';

    // Rebuild if endpoint or token changed
    if (this.cachedModelInstance && endpoint === this.cachedEndpoint && token === this.cachedToken) {
      return this.cachedModelInstance;
    }

    this.cachedEndpoint = endpoint;
    this.cachedToken = token;

    // Custom fetch that:
    // 1. Injects required Copilot headers
    // 2. Auto-refreshes the Copilot token if expired
    const self = this;
    const customFetch: typeof globalThis.fetch = async (input, init) => {
      // Ensure we have a fresh copilot token
      let ct = self._lastCopilotToken;
      const now = Date.now() / 1000;
      if (!ct || ct.expiresAt <= now + 30) {
        ct = await getValidCopilotToken();
        if (ct) self._lastCopilotToken = ct;
      }

      if (!ct) {
        throw new Error('GitHub Copilot: failed to obtain Copilot token. Is Copilot enabled for your account?');
      }

      // Rewrite URL to use the correct Copilot API endpoint
      let url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      // Replace any base URL with the one from the token exchange
      const urlPath = new URL(url).pathname;
      url = `${ct.apiEndpoint}${urlPath}`;

      // Merge headers
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${ct.token}`);
      for (const [k, v] of Object.entries(COPILOT_HEADERS)) {
        headers.set(k, v);
      }

      return globalThis.fetch(url, {
        ...init,
        headers,
      });
    };

    const client = createOpenAI({
      apiKey: 'copilot-managed', // placeholder, custom fetch overrides Authorization
      baseURL: `${endpoint}/chat/completions`.replace('/chat/completions', ''),
      fetch: customFetch,
    });

    this.cachedModelInstance = client.chat(this.model as any);
    return this.cachedModelInstance;
  }
}
