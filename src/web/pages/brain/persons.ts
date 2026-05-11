import { Context } from 'hono';
import { renderLayout } from '../layout.js';

export function renderPersons(c: Context): string {
  const body = `
<div class="page" x-data="personsBrowser()" x-init="init()">
  <div class="page-header">
    <h1>Persons</h1>
    <p class="page-subtitle">People inferred from relationship and episode memories</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2>Search</h2>
    </div>
    <div class="card-body">
      <input type="text" class="form-input" placeholder="Search people by name..." x-model="query" @keyup.debounce.250ms="search()">
    </div>
  </div>

  <div class="card">
    <div class="card-header">
      <h2 x-text="'People (' + persons.length + ')'">People</h2>
    </div>
    <div class="card-body">
      <div x-show="loading" class="loading">Loading...</div>
      <div x-show="!loading && persons.length === 0" class="empty-state">
        No person profiles yet. Relationship memories will populate this view.
      </div>

      <div class="memory-list">
        <template x-for="p in persons" :key="p.id">
          <a class="memory-item" :href="'/second-brain/persons/' + p.id">
            <div class="memory-header">
              <div class="memory-summary" x-text="p.name"></div>
              <span class="memory-confidence" x-text="(p.memoryCount || 0) + ' memories'"></span>
            </div>
            <div class="memory-meta" x-show="p.relationshipToUser">
              <span x-text="'Relation to user: ' + p.relationshipToUser"></span>
            </div>
          </a>
        </template>
      </div>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Persons', body);
}
