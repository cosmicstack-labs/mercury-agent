import { Context } from 'hono';
import { renderLayout } from '../layout.js';

const TYPE_LABELS: Record<string, string> = {
  identity: 'Identity',
  preference: 'Preference',
  goal: 'Goal',
  project: 'Project',
  habit: 'Habit',
  decision: 'Decision',
  constraint: 'Constraint',
  relationship: 'Relationship',
  episode: 'Episode',
  reflection: 'Reflection',
};

const TYPE_COLORS: Record<string, string> = {
  identity: '#00d4ff',
  preference: '#febc2e',
  goal: '#28c840',
  project: '#a855f7',
  habit: '#f97316',
  decision: '#3b82f6',
  constraint: '#ef4444',
  relationship: '#ec4899',
  episode: '#6366f1',
  reflection: '#14b8a6',
};

export function renderMemory(c: Context, stats: any): string {
  const typeFilters = Object.entries(TYPE_LABELS).map(([key, label]) => `
    <label class="filter-chip" x-data="{ checked: true }">
      <input type="checkbox" :checked="checked" @change="filterMemories()" x-model="checked"
             class="filter-check" value="${key}">
      <span class="filter-dot" style="background: ${TYPE_COLORS[key]}"></span>
      ${label}
    </label>
  `).join('\n');

  const body = `
<div class="page" x-data="memoryBrowser()" x-init="init()">
  <div class="page-header">
    <h1>Memory</h1>
    <p class="page-subtitle">Browse and manage your second brain memories</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Search & Filter</h2>
    </div>
    <div class="card-body">
      <div class="form-row">
        <input type="text" class="form-input" placeholder="Search memories..."
               x-model="query" @keyup.debounce.300ms="search()">
      </div>
      <div class="filter-bar">${typeFilters}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2 x-text="'Memories (' + memories.length + ')'">Memories</h2>
      <button class="btn btn-primary btn-sm" @click="showAddModal = true">+ Add Memory</button>
    </div>
    <div class="card-body">
      <div x-show="loading" class="loading">Loading...</div>
      <div x-show="!loading && memories.length === 0" class="empty-state">
        No memories found. Start a conversation to build your second brain.
      </div>
      <div class="memory-list">
        <template x-for="mem in memories" :key="mem.id">
          <div class="memory-item" @click="selectMemory(mem)">
            <div class="memory-header">
              <span class="memory-type" :style="'background:' + getTypeColor(mem.type)" x-text="mem.type"></span>
              <span class="memory-confidence" x-text="(mem.confidence * 100).toFixed(0) + '%'"></span>
            </div>
            <div class="memory-summary" x-text="mem.summary"></div>
            <div class="memory-meta">
              <span x-text="formatDate(mem.createdAt)"></span>
              <span x-show="mem.scope" x-text="'· ' + mem.scope"></span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <div class="modal" x-show="showAddModal" x-transition @click.self="showAddModal = false">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Add Memory</h3>
        <button class="btn btn-sm" @click="showAddModal = false">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label class="form-label">Type</label>
          <select class="form-input" x-model="newMemory.type">
            <template x-for="[val, label] in Object.entries(memoryTypes)" :key="val">
              <option :value="val" x-text="label"></option>
            </template>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Summary</label>
          <input type="text" class="form-input" x-model="newMemory.summary" placeholder="What should Mercury remember?">
        </div>
        <div class="form-row">
          <label class="form-label">Detail (optional)</label>
          <textarea class="form-input" x-model="newMemory.detail" rows="3" placeholder="Additional context..."></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" @click="showAddModal = false">Cancel</button>
        <button class="btn btn-primary" @click="addMemory()" :disabled="!newMemory.summary">Add</button>
      </div>
    </div>
  </div>

  <div class="modal" x-show="selectedMemory" x-transition @click.self="selectedMemory = null">
    <div class="modal-content" x-show="selectedMemory">
      <template x-if="selectedMemory">
        <div>
          <div class="modal-header">
            <h3 x-text="selectedMemory?.summary?.slice(0, 60)"></h3>
            <button class="btn btn-sm" @click="selectedMemory = null">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">Type</span>
                <span class="detail-value" x-text="selectedMemory?.type"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Scope</span>
                <span class="detail-value" x-text="selectedMemory?.scope"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Confidence</span>
                <span class="detail-value" x-text="(selectedMemory?.confidence * 100).toFixed(0) + '%'"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Importance</span>
                <span class="detail-value" x-text="(selectedMemory?.importance * 100).toFixed(0) + '%'"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Source</span>
                <span class="detail-value" x-text="selectedMemory?.source"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Created</span>
                <span class="detail-value" x-text="formatDate(selectedMemory?.createdAt)"></span>
              </div>
            </div>
            <div class="form-row" x-show="selectedMemory?.detail" style="margin-top: 16px;">
              <label class="form-label">Detail</label>
              <div class="detail-text" x-text="selectedMemory?.detail"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline btn-sm" style="color: var(--red);"
                    @click="deleteMemory(selectedMemory?.id)">Delete</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Memory', body);
}