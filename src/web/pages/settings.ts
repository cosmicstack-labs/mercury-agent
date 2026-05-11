import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderSettings(c: Context, config: any, username: string): string {
  const body = `
<div class="page" x-data="settings()">
  <div class="page-header">
    <h1>Settings</h1>
  </div>

  <div class="card">
    <div class="card-header"><h2>Authentication</h2></div>
    <div class="card-body">
      <div class="form-row">
        <label class="form-label">Current Username</label>
        <span class="form-value">${username}</span>
      </div>
      <form @submit.prevent="changeUsername()" class="form-section">
        <div class="form-row">
          <label class="form-label form-label-sm">New Username</label>
          <input type="text" x-model="newUsername" class="form-input form-input-sm" required>
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">Current Password</label>
          <input type="password" x-model="currentPassword" class="form-input form-input-sm" required>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="savingUsername" x-text="savingUsername ? 'Saving...' : 'Change Username'"></button>
        <span class="form-feedback" x-show="usernameFeedback" x-text="usernameFeedback" x-transition></span>
      </form>
      <hr class="divider">
      <form @submit.prevent="changePassword()" class="form-section">
        <div class="form-row">
          <label class="form-label form-label-sm">Current Password</label>
          <input type="password" x-model="currentPasswordPw" class="form-input form-input-sm" required>
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">New Password</label>
          <input type="password" x-model="newPassword" class="form-input form-input-sm" required>
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">Confirm New Password</label>
          <input type="password" x-model="confirmPassword" class="form-input form-input-sm" required>
        </div>
        <button class="btn btn-primary btn-sm" :disabled="savingPassword" x-text="savingPassword ? 'Saving...' : 'Change Password'"></button>
        <span class="form-feedback" x-show="passwordFeedback" x-text="passwordFeedback" x-transition></span>
      </form>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Theme</h2></div>
    <div class="card-body">
      <div class="form-row">
        <label class="form-label">Appearance</label>
        <div class="theme-options" x-data="{ theme: localStorage.getItem('mercury-theme') || (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') }">
          <label class="radio-label">
            <input type="radio" name="theme" value="dark" x-model="theme" @change="setTheme(theme)">
            Dark
          </label>
          <label class="radio-label">
            <input type="radio" name="theme" value="light" x-model="theme" @change="setTheme(theme)">
            Light
          </label>
          <label class="radio-label">
            <input type="radio" name="theme" value="system" x-model="theme" @change="setTheme(theme)">
            System
          </label>
        </div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Agent Identity</h2></div>
    <div class="card-body">
      <form @submit.prevent="saveIdentity()" class="form-section">
        <div class="form-row">
          <label class="form-label form-label-sm">Agent Name</label>
          <input type="text" x-model="identity.name" class="form-input form-input-sm">
        </div>
        <div class="form-row">
          <label class="form-label form-label-sm">Owner Name</label>
          <input type="text" x-model="identity.owner" class="form-input form-input-sm">
        </div>
        <button class="btn btn-primary btn-sm" :disabled="savingIdentity" x-text="savingIdentity ? 'Saving...' : 'Save Identity'"></button>
        <span class="form-feedback" x-show="identityFeedback" x-text="identityFeedback" x-transition></span>
      </form>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><h2>Default Provider</h2></div>
    <div class="card-body">
      <div class="form-row">
        <label class="form-label form-label-sm">Default</label>
        <select x-model="defaultProvider" class="form-input form-input-sm" @change="saveDefaultProvider()">
          <option value="deepseek">DeepSeek</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="grok">Grok</option>
          <option value="ollamaCloud">Ollama Cloud</option>
          <option value="ollamaLocal">Ollama Local</option>
        </select>
        <span class="form-feedback" x-show="providerFeedback" x-text="providerFeedback" x-transition></span>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Settings', body);
}