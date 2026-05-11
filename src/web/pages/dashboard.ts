import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderDashboard(c: Context, status: any): string {
  const body = `
<div class="page" x-data="dashboard()" x-init="init()">
  <div class="page-header">
    <h1>Dashboard</h1>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Status</div>
      <div class="stat-value" :class="status.running ? 'stat-green' : 'stat-red'" x-text="status.running ? 'Running' : 'Stopped'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Uptime</div>
      <div class="stat-value" x-text="status.uptime || '—'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">State</div>
      <div class="stat-value" x-text="status.state || '—'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Provider</div>
      <div class="stat-value" x-text="status.defaultProvider || '—'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Today's Tokens</div>
      <div class="stat-value" x-text="status.tokensUsed || '0'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Budget</div>
      <div class="stat-value" x-text="status.tokenBudget || '—'">—</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Providers</h2>
    </div>
    <div class="card-body">
      <div class="provider-grid">
        <template x-for="p in status.providers" :key="p.name">
          <div class="provider-chip" :class="{ 'provider-active': p.enabled && p.hasKey }">
            <span class="provider-name" x-text="p.name"></span>
            <span class="provider-status" :class="p.enabled && p.hasKey ? 'dot-green' : 'dot-gray'"></span>
          </div>
        </template>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Memory</h2>
    </div>
    <div class="card-body">
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));">
        <div class="stat-card stat-sm">
          <div class="stat-label">Total</div>
          <div class="stat-value" x-text="status.memoryTotal || '0'">—</div>
        </div>
        <template x-for="(count, type) in status.memoryByType" :key="type">
          <div class="stat-card stat-sm">
            <div class="stat-label" x-text="type"></div>
            <div class="stat-value" x-text="count"></div>
          </div>
        </template>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Dashboard', body);
}