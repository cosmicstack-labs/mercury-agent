import { Context } from 'hono';
import { renderLayout } from '../layout.js';

export function renderGoals(c: Context): string {
  const body = `
<div class="page" x-data="goalsBrowser()" x-init="init()">
  <div class="page-header">
    <h1>Goals & Projects</h1>
    <p class="page-subtitle">Track your goals, projects, and commitments</p>
  </div>

  <div class="card">
    <div class="card-header">
      <h2 x-text="'Goals (' + goals.length + ')'">Goals</h2>
      <button class="btn btn-primary btn-sm" @click="showAddGoal = true">+ Add Goal</button>
    </div>
    <div class="card-body">
      <div x-show="loading" class="loading">Loading...</div>
      <div x-show="!loading && goals.length === 0" class="empty-state">
        No goals set yet. Add one to track what matters to you.
      </div>
      <div class="memory-list">
        <template x-for="goal in goals" :key="goal.id">
          <div class="memory-item" @click="selectedGoal = goal">
            <div class="memory-header">
              <span class="memory-type" style="background: var(--green)" x-text="goal.type === 'project' ? 'Project' : 'Goal'"></span>
              <span class="memory-confidence" x-text="(goal.importance * 100).toFixed(0) + '%'"></span>
            </div>
            <div class="memory-summary" x-text="goal.summary"></div>
            <div class="memory-meta">
              <span x-text="formatDate(goal.createdAt)"></span>
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>

  <div class="modal" x-show="showAddGoal" x-transition @click.self="showAddGoal = false">
    <div class="modal-content">
      <div class="modal-header">
        <h3>Add Goal</h3>
        <button class="btn btn-sm" @click="showAddGoal = false">&times;</button>
      </div>
      <div class="modal-body">
        <div class="form-row">
          <label class="form-label">Type</label>
          <select class="form-input" x-model="newGoal.type">
            <option value="goal">Goal</option>
            <option value="project">Project</option>
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">Summary</label>
          <input type="text" class="form-input" x-model="newGoal.summary" placeholder="What do you want to achieve?">
        </div>
        <div class="form-row">
          <label class="form-label">Detail (optional)</label>
          <textarea class="form-input" x-model="newGoal.detail" rows="3" placeholder="More context..."></textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-outline" @click="showAddGoal = false">Cancel</button>
        <button class="btn btn-primary" @click="addGoal()" :disabled="!newGoal.summary">Add</button>
      </div>
    </div>
  </div>

  <div class="modal" x-show="selectedGoal" x-transition @click.self="selectedGoal = null">
    <div class="modal-content" x-show="selectedGoal">
      <template x-if="selectedGoal">
        <div>
          <div class="modal-header">
            <h3 x-text="selectedGoal?.summary?.slice(0, 60)"></h3>
            <button class="btn btn-sm" @click="selectedGoal = null">&times;</button>
          </div>
          <div class="modal-body">
            <div class="detail-grid">
              <div class="detail-item">
                <span class="detail-label">Type</span>
                <span class="detail-value" x-text="selectedGoal?.type === 'project' ? 'Project' : 'Goal'"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Importance</span>
                <span class="detail-value" x-text="(selectedGoal?.importance * 100).toFixed(0) + '%'"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Confidence</span>
                <span class="detail-value" x-text="(selectedGoal?.confidence * 100).toFixed(0) + '%'"></span>
              </div>
              <div class="detail-item">
                <span class="detail-label">Created</span>
                <span class="detail-value" x-text="formatDate(selectedGoal?.createdAt)"></span>
              </div>
            </div>
            <div class="form-row" x-show="selectedGoal?.detail" style="margin-top: 16px;">
              <label class="form-label">Detail</label>
              <div class="detail-text" x-text="selectedGoal?.detail"></div>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-outline btn-sm" style="color: var(--red);"
                    @click="deleteGoal(selectedGoal?.id)">Delete</button>
          </div>
        </div>
      </template>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Goals', body);
}