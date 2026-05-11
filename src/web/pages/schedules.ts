import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderSchedules(c: Context): string {
  const body = `
<div class="page" x-data="schedulesPage()" x-init="init()">
  <div class="page-header">
    <h1>Schedules</h1>
    <p class="page-subtitle">Track repeating and one-time scheduled events</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2 x-text="'Scheduled Events (' + schedules.length + ')'">Scheduled Events</h2>
      <button class="btn btn-sm btn-outline" @click="init()">Refresh</button>
    </div>
    <div class="card-body">
      <div class="loading" x-show="loading">Loading schedules...</div>
      <div class="empty-state" x-show="!loading && schedules.length === 0">No scheduled events yet.</div>
      <div class="memory-list">
        <template x-for="s in schedules" :key="s.id">
          <div class="memory-item" @click="select(s)">
            <div class="memory-header">
              <div class="memory-summary" x-text="s.description"></div>
              <span class="memory-confidence" x-text="s.cron ? 'repeating' : 'one-time'"></span>
            </div>
            <div class="memory-meta" x-text="s.cron ? ('Cron: ' + s.cron) : ('Executes at: ' + (s.executeAt || '—'))"></div>
            <div class="memory-meta" x-text="'ID: ' + s.id"></div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <div class="card" x-show="selected">
    <div class="card-header">
      <h2>Edit Event</h2>
    </div>
    <div class="card-body">
      <div class="form-row">
        <label class="form-label">Description</label>
        <input class="form-input" x-model="form.description" type="text">
      </div>
      <div class="form-row">
        <label class="form-label">Cron (for repeating events)</label>
        <input class="form-input" x-model="form.cron" type="text" placeholder="0 9 * * *">
      </div>
      <div class="form-row">
        <label class="form-label">Delay Seconds (for one-time events)</label>
        <input class="form-input" x-model.number="form.delaySeconds" type="number" min="1" placeholder="3600">
      </div>
      <div class="form-row">
        <label class="form-label">Prompt</label>
        <textarea class="form-input" rows="3" x-model="form.prompt"></textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" @click="save()" :disabled="saving"><span x-text="saving ? 'Saving...' : 'Save Changes'"></span></button>
        <button class="btn btn-danger" @click="removeSelected()">Delete / Cancel</button>
        <span class="form-feedback" x-text="feedback"></span>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Schedules', body);
}
