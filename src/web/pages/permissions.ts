import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderPermissions(c: Context): string {
  const body = `
<div class="page" x-data="permissionsPage()" x-init="init()">
  <div class="page-header">
    <h1>Permissions</h1>
    <p class="page-subtitle">Capability guards used by Mercury tools</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Filesystem</h2>
    </div>
    <div class="card-body">
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.filesystem.enabled"> Enabled</label>
      <div class="detail-text" x-text="'Scopes: ' + (manifest.capabilities.filesystem.scopes || []).length"></div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Shell</h2>
    </div>
    <div class="card-body">
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.shell.enabled"> Enabled</label>
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.shell.cwdOnly"> Restrict to CWD</label>
      <div class="detail-grid">
        <div class="detail-item"><span class="detail-label">Auto-approved</span><span class="detail-value" x-text="(manifest.capabilities.shell.autoApproved || []).length"></span></div>
        <div class="detail-item"><span class="detail-label">Needs approval</span><span class="detail-value" x-text="(manifest.capabilities.shell.needsApproval || []).length"></span></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Git</h2>
    </div>
    <div class="card-body">
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.git.enabled"> Enabled</label>
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.git.autoApproveRead"> Auto-approve read</label>
      <label class="radio-label" style="margin-bottom:8px;"><input type="checkbox" x-model="manifest.capabilities.git.approveWrite"> Require write approval</label>
    </div>
  </div>

  <div class="form-actions">
    <button class="btn btn-outline" @click="init()">Reload</button>
    <button class="btn btn-primary" @click="save()" :disabled="saving">
      <span x-text="saving ? 'Saving...' : 'Save'">Save</span>
    </button>
    <span class="form-feedback" x-text="feedback"></span>
  </div>
</div>`;

  return renderLayout(c, 'Permissions', body);
}
