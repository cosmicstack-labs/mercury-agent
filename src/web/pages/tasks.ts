import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderTasks(c: Context): string {
  const body = `
<div class="page-header">
  <h1>Background Tasks & Agents</h1>
</div>
<div x-data="tasksPage()" x-init="init()">
  <!-- Sub-Agents Section -->
  <div class="card" style="margin-bottom:1.5rem">
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
      <h2>Sub-Agents</h2>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-sm btn-danger" @click="haltAll()" x-show="agents.length > 0">Halt All</button>
        <button class="btn btn-sm" @click="refresh()">Refresh</button>
      </div>
    </div>
    <div class="card-body">
      <template x-if="!agentsAvailable">
        <p class="text-muted">Sub-agents not enabled in this session.</p>
      </template>
      <template x-if="agentsAvailable && agents.length === 0">
        <p class="text-muted">No active sub-agents.</p>
      </template>
      <template x-if="agents.length > 0">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Progress</th></tr></thead>
            <tbody>
              <template x-for="a in agents" :key="a.id">
                <tr>
                  <td x-text="a.id" style="font-family:monospace;font-size:0.8rem"></td>
                  <td x-text="a.task.slice(0,80)"></td>
                  <td><span class="badge" :class="statusClass(a.status)" x-text="a.status"></span></td>
                  <td x-text="a.progress || '—'"></td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>
    </div>
  </div>

  <!-- Background Tasks Section -->
  <div class="card">
    <div class="card-header" style="display:flex;justify-content:space-between;align-items:center">
      <h2>Background Tasks</h2>
      <div style="display:flex;gap:0.5rem">
        <button class="btn btn-sm" @click="clearCompleted()" x-show="bgTasks.some(t => t.status !== 'running')">Clear Done</button>
        <button class="btn btn-sm" @click="refresh()">Refresh</button>
      </div>
    </div>
    <div class="card-body">
      <template x-if="!bgAvailable">
        <p class="text-muted">Background task manager not available.</p>
      </template>
      <template x-if="bgAvailable && bgTasks.length === 0">
        <p class="text-muted">No background tasks.</p>
      </template>
      <template x-if="bgTasks.length > 0">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>ID</th><th>Description</th><th>Status</th><th>Duration</th><th>Actions</th></tr></thead>
            <tbody>
              <template x-for="t in bgTasks" :key="t.id">
                <tr>
                  <td x-text="t.id" style="font-family:monospace;font-size:0.8rem"></td>
                  <td x-text="(t.command || t.task || t.id).slice(0,60)"></td>
                  <td><span class="badge" :class="statusClass(t.status)" x-text="t.status"></span></td>
                  <td x-text="formatDuration(t)"></td>
                  <td>
                    <button class="btn btn-xs btn-danger" @click="cancelTask(t.id)" x-show="t.status === 'running'">Cancel</button>
                    <button class="btn btn-xs" @click="viewTask(t.id)" x-show="t.status !== 'running'">View</button>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </template>

      <!-- Task detail modal -->
      <template x-if="selectedTask">
        <div class="modal-overlay" @click.self="selectedTask = null">
          <div class="modal" style="max-width:600px">
            <div class="modal-header">
              <h3 x-text="selectedTask.id"></h3>
              <button @click="selectedTask = null">&times;</button>
            </div>
            <div class="modal-body">
              <p><strong>Command:</strong> <span x-text="selectedTask.command || selectedTask.task || '—'"></span></p>
              <p><strong>Status:</strong> <span x-text="selectedTask.status"></span></p>
              <p><strong>Exit Code:</strong> <span x-text="selectedTask.exitCode ?? '—'"></span></p>
              <pre class="code-block" x-text="selectedTask.output || '(no output)'" style="max-height:300px;overflow:auto"></pre>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</div>`;

  return renderLayout(c, 'Tasks', body);
}
