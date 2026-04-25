import { Context } from 'hono';
import { renderLayout } from '../layout.js';

export function renderPerson(c: Context, personId: string): string {
  const body = `
<div class="page" x-data="personDetail('${personId}')" x-init="init()">
  <div class="page-header">
    <h1>Person Profile</h1>
    <p class="page-subtitle"><a href="/second-brain/persons">← Back to persons</a></p>
  </div>

  <div class="card" x-show="loading">
    <div class="card-body">
      <div class="loading">Loading person profile...</div>
    </div>
  </div>

  <div class="card" x-show="!loading && !person">
    <div class="card-body">
      <div class="empty-state">Person not found.</div>
    </div>
  </div>

  <div x-show="!loading && person">
    <div class="card">
      <div class="card-header">
        <h2 x-text="person?.name || 'Person'"></h2>
      </div>
      <div class="card-body">
        <div class="detail-grid">
          <div class="detail-item">
            <span class="detail-label">Relation to User</span>
            <span class="detail-value" x-text="person?.relationshipToUser || 'unknown'"></span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Memories Logged</span>
            <span class="detail-value" x-text="person?.memoryCount || 0"></span>
          </div>
          <div class="detail-item">
            <span class="detail-label">First Seen</span>
            <span class="detail-value" x-text="formatDate(person?.firstSeenAt)"></span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Last Seen</span>
            <span class="detail-value" x-text="formatDate(person?.lastSeenAt)"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">
        <h2 x-text="'Interaction Log (' + memories.length + ')'">Interaction Log</h2>
      </div>
      <div class="card-body">
        <div class="empty-state" x-show="memories.length === 0">No logged interactions yet.</div>
        <div class="memory-list">
          <template x-for="m in memories" :key="m.id">
            <div class="memory-item">
              <div class="memory-header">
                <span class="memory-type" :style="'background:' + getTypeColor(m.type)" x-text="m.type"></span>
                <span class="memory-confidence" x-text="formatDate(m.updatedAt)"></span>
              </div>
              <div class="memory-summary" x-text="m.summary"></div>
              <div class="memory-meta" x-show="m.detail">
                <span x-text="m.detail"></span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Person Profile', body);
}
