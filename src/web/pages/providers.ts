import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderProviders(c: Context, providers: any[]): string {
  const providerCards = providers.map(p => `
    <div class="card provider-card" id="provider-${p.name}" x-data="providerCard('${p.name}', '${p.maskedKey}', '${p.baseUrl}', '${p.model}', ${p.enabled})">
      <div class="card-header">
        <h2 x-text="name"></h2>
        <div class="provider-toggle-wrap">
          <span class="dot" :class="enabled && hasKey ? 'dot-green' : 'dot-gray'"></span>
          <button class="btn btn-sm" :class="enabled ? 'btn-outline' : 'btn-primary'"
                  @click="enabled = !enabled; $nextTick(() => save())"
                  x-text="enabled ? 'Enabled' : 'Disabled'"></button>
        </div>
      </div>
      <div class="card-body">
        <div class="form-row">
          <label class="form-label form-label-sm">API Key</label>
          <div class="input-group">
            <input type="password" class="form-input form-input-sm" :type="showKey ? 'text' : 'password'"
                   x-model="key" :placeholder="maskedKey || 'Enter API key'">
            <button class="btn btn-sm btn-outline" @click="showKey = !showKey" x-text="showKey ? 'Hide' : 'Show'"></button>
          </div>
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">Base URL</label>
          <input type="text" class="form-input form-input-sm" x-model="baseUrl">
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">Model</label>
          <input type="text" class="form-input form-input-sm" x-model="model">
        </div>
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" @click="save()" :disabled="saving" x-text="saving ? 'Saving...' : 'Save'"></button>
          <button class="btn btn-outline btn-sm" @click="testKey()" :disabled="testing" x-text="testing ? 'Testing...' : 'Test'"></button>
          <span class="form-feedback" x-show="feedback" x-text="feedback" x-transition></span>
        </div>
      </div>
    </div>
  `).join('\n');

  const body = `
<div class="page">
  <div class="page-header">
    <h1>Provider Keys</h1>
    <p class="page-subtitle">Manage your LLM provider API keys and settings</p>
  </div>
  ${providerCards}
</div>`;

  return renderLayout(c, 'Providers', body);
}