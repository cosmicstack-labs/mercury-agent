import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderDashboard(c: Context, status: any): string {
  const body = `
<div class="page" x-data="dashboard()" x-init="init()">
  <div class="page-header">
    <h1>Dashboard</h1>
    <p>System overview and status</p>
  </div>

  <!-- Hero status -->
  <div class="stat-hero" style="margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px;">
    <div>
      <div style="font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-muted); margin-bottom: 6px;">Agent Status</div>
      <div style="display: flex; align-items: center; gap: 12px;">
        <span class="stat-value" style="font-size: 1.5rem;" :class="status.running ? '' : ''" x-text="status.running ? 'Running' : 'Stopped'">—</span>
        <span class="badge" :class="status.running ? 'badge-success' : 'badge-danger'" x-text="status.state || 'unknown'"></span>
      </div>
    </div>
    <div style="text-align: right;">
      <div style="font-size: 0.6875rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; color: var(--text-muted); margin-bottom: 6px;">Uptime</div>
      <div style="font-family: var(--font-mono); font-size: 1.125rem; font-weight: 600; color: var(--text);" x-text="status.uptime || '—'">—</div>
    </div>
  </div>

  <!-- Quick stats row -->
  <div class="stats-grid" style="grid-template-columns: repeat(4, 1fr);">
    <div class="stat-card">
      <div class="stat-label">Provider</div>
      <div class="stat-value" style="font-size: 0.9375rem;" x-text="status.defaultProvider || '—'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Today's Tokens</div>
      <div class="stat-value" style="font-size: 0.9375rem;" x-text="status.tokensUsed || '0'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Budget</div>
      <div class="stat-value" style="font-size: 0.9375rem;" x-text="status.tokenBudget || '—'">—</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Memories</div>
      <div class="stat-value" style="font-size: 0.9375rem;" x-text="status.memoryTotal || '0'">—</div>
    </div>
  </div>

  <!-- Providers card -->
  <div class="card">
    <div class="card-header">
      <h2>Providers</h2>
      <a href="/providers" class="btn btn-ghost btn-sm">Manage</a>
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

  <!-- Memory breakdown -->
  <div class="card">
    <div class="card-header">
      <h2>Memory</h2>
      <a href="/second-brain/memory" class="btn btn-ghost btn-sm">Browse</a>
    </div>
    <div class="card-body">
      <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));">
        <template x-for="(count, type) in status.memoryByType" :key="type">
          <div class="stat-card stat-sm">
            <div class="stat-label" x-text="type"></div>
            <div class="stat-value" x-text="count"></div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- Spotify Widget -->
  <div class="card" x-data="spotifyWidget()" x-init="init()" x-show="available">
    <div class="card-header">
      <h2>Spotify</h2>
      <span class="badge" :class="connected ? 'badge-success' : 'badge-danger'" x-text="connected ? 'Connected' : 'Not Connected'"></span>
    </div>
    <div class="card-body" x-show="connected">
      <p class="text-muted text-sm" style="margin-bottom: 6px" x-show="accountName">Account: <strong x-text="accountName"></strong></p>
      <p style="margin-bottom: 12px; font-size: 0.875rem; color: var(--text);" x-text="nowPlaying || 'Nothing playing'"></p>
      <div class="spotify-controls">
        <button class="btn btn-outline btn-sm" @click="prev()" :disabled="loading">⏮</button>
        <button class="btn btn-primary btn-sm" @click="play()" :disabled="loading">▶</button>
        <button class="btn btn-outline btn-sm" @click="pause()" :disabled="loading">⏸</button>
        <button class="btn btn-outline btn-sm" @click="next()" :disabled="loading">⏭</button>
        <button class="btn btn-ghost btn-sm" @click="refreshNowPlaying()" style="margin-left: auto">↻</button>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Dashboard', body);
}
