import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderUsage(c: Context): string {
  const body = `
<div class="page" x-data="usagePage()" x-init="init()">
  <div class="page-header">
    <h1>Usage</h1>
    <p class="page-subtitle">Daily token usage and recent request log</p>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Used</div>
      <div class="stat-value" x-text="formatNum(data.dailyUsed)">0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Budget</div>
      <div class="stat-value" x-text="formatNum(data.dailyBudget)">0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Remaining</div>
      <div class="stat-value" x-text="formatNum(data.remaining)">0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Reset Date</div>
      <div class="stat-value" x-text="data.lastResetDate || '—'">—</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>By Provider</h2>
      <button class="btn btn-sm btn-outline" @click="init()">Refresh</button>
    </div>
    <div class="card-body">
      <div class="provider-grid">
        <template x-for="(value, key) in (data.byProvider || {})" :key="key">
          <span class="provider-chip"><span class="provider-name" x-text="key"></span><span class="memory-confidence" x-text="formatNum(value)"></span></span>
        </template>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Recent Requests</h2>
    </div>
    <div class="card-body">
      <div class="empty-state" x-show="(data.requestLog || []).length === 0">No usage records yet.</div>
      <div class="memory-list">
        <template x-for="row in (data.requestLog || [])" :key="row.timestamp + '-' + row.provider + '-' + row.model">
          <div class="memory-item">
            <div class="memory-header">
              <div class="memory-summary" x-text="row.provider + ' · ' + row.model"></div>
              <span class="memory-confidence" x-text="formatNum(row.totalTokens) + ' tokens'"></span>
            </div>
            <div class="memory-meta" x-text="formatDate(row.timestamp) + ' · ' + (row.channelType || 'unknown')"></div>
          </div>
        </template>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Usage', body);
}
