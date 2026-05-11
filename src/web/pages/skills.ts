import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderSkills(c: Context): string {
  const body = `
<div class="page" x-data="skillsPage()" x-init="init()">
  <div class="page-header">
    <h1>Skills</h1>
    <p class="page-subtitle">Installed skills discovered from ~/.mercury/skills</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Install From URL</h2>
    </div>
    <div class="card-body">
      <div class="form-row">
        <input type="text" class="form-input" x-model="installUrl" placeholder="https://.../SKILL.md">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" @click="installFromUrl()" :disabled="installing || !installUrl.trim()">
          <span x-text="installing ? 'Installing...' : 'Install Skill'"></span>
        </button>
        <span class="form-feedback" x-text="feedback"></span>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2 x-text="'Installed (' + skills.length + ')'">Installed</h2>
      <button class="btn btn-sm btn-outline" @click="init()">Refresh</button>
    </div>
    <div class="card-body">
      <div class="loading" x-show="loading">Loading skills...</div>
      <div class="empty-state" x-show="!loading && skills.length === 0">No skills installed yet.</div>
      <div class="memory-list">
        <template x-for="s in skills" :key="s.name">
          <div class="memory-item">
            <div class="memory-header">
              <div class="memory-summary" x-text="s.name"></div>
              <span class="memory-confidence" x-text="s.active ? (s.version ? ('active · v' + s.version) : 'active') : 'inactive'"></span>
            </div>
            <div class="memory-meta" x-text="s.description"></div>
            <div class="provider-grid" style="margin-top:8px;" x-show="(s.allowedTools || []).length > 0">
              <template x-for="tool in s.allowedTools" :key="tool">
                <span class="provider-chip"><span class="provider-name" x-text="tool"></span></span>
              </template>
            </div>
            <div class="form-actions" style="margin-top:10px;">
              <button class="btn btn-sm btn-outline" x-show="!s.active" @click="activateSkill(s.name)">Activate</button>
              <button class="btn btn-sm btn-outline" x-show="s.active" @click="deactivateSkill(s.name)">Deactivate</button>
              <button class="btn btn-sm btn-danger" @click="deleteSkill(s.name)">Delete</button>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Skills', body);
}
