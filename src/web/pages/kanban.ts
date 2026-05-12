import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderKanban(c: Context): string {
  const body = `
<div x-data="kanbanBoard()" x-init="init()" class="kanban-page">

  <!-- Header -->
  <div class="kanban-header">
    <div class="kanban-header-left">
      <h1 class="kanban-title">Board</h1>
      <div class="kanban-resource-bar" x-show="resources">
        <span class="kanban-resource-chip">
          <span class="kanban-resource-dot" :class="resources.activeAgents > 0 ? 'dot-green' : 'dot-gray'"></span>
          <span x-text="resources.activeAgents + '/' + resources.maxConcurrentAgents + ' agents'"></span>
        </span>
        <span class="kanban-resource-chip" x-show="resources.queuedAgents > 0">
          <span x-text="resources.queuedAgents + ' queued'"></span>
        </span>
      </div>
    </div>
    <div class="kanban-header-actions">
      <button class="btn btn-sm btn-outline" @click="clearDone()" x-show="doneCount > 0">
        Clear Done (<span x-text="doneCount"></span>)
      </button>
      <button class="btn btn-sm btn-danger" @click="haltAll()" x-show="activeCount > 0">Halt All</button>
      <button class="btn btn-sm btn-primary" @click="showSpawn = true">+ New Task</button>
    </div>
  </div>

  <!-- Kanban Columns -->
  <div class="kanban-columns">

    <!-- Pending / Queued -->
    <div class="kanban-col">
      <div class="kanban-col-head">
        <span class="kanban-col-title">Queued</span>
        <span class="kanban-col-count" x-text="byStatus('pending').length"></span>
      </div>
      <div class="kanban-col-body">
        <template x-for="card in byStatus('pending')" :key="card.agentId">
          <div class="kanban-card" @click="selectCard(card)">
            <div class="kanban-card-id" x-text="card.agentId"></div>
            <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
            <div class="kanban-card-footer">
              <span class="badge badge-neutral" x-text="card.priority"></span>
              <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
            </div>
          </div>
        </template>
        <div class="kanban-col-empty" x-show="byStatus('pending').length === 0">No queued tasks</div>
      </div>
    </div>

    <!-- Running -->
    <div class="kanban-col kanban-col-active">
      <div class="kanban-col-head">
        <span class="kanban-col-title">Running</span>
        <span class="kanban-col-count kanban-col-count-active" x-text="byStatus('running').length"></span>
      </div>
      <div class="kanban-col-body">
        <template x-for="card in byStatus('running')" :key="card.agentId">
          <div class="kanban-card kanban-card-running" @click="selectCard(card)">
            <div class="kanban-card-top">
              <span class="kanban-card-id" x-text="card.agentId"></span>
              <span class="step-spinner-sm"></span>
            </div>
            <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
            <div class="kanban-card-progress" x-show="card.progress" x-text="card.progress"></div>
            <div class="kanban-card-footer">
              <span class="badge badge-info" x-text="card.priority"></span>
              <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
              <span class="kanban-card-elapsed" x-text="elapsed(card)"></span>
            </div>
          </div>
        </template>
        <div class="kanban-col-empty" x-show="byStatus('running').length === 0">No running tasks</div>
      </div>
    </div>

    <!-- Paused -->
    <div class="kanban-col" x-show="byStatus('paused').length > 0">
      <div class="kanban-col-head">
        <span class="kanban-col-title">Paused</span>
        <span class="kanban-col-count" x-text="byStatus('paused').length"></span>
      </div>
      <div class="kanban-col-body">
        <template x-for="card in byStatus('paused')" :key="card.agentId">
          <div class="kanban-card kanban-card-paused" @click="selectCard(card)">
            <div class="kanban-card-id" x-text="card.agentId"></div>
            <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
            <div class="kanban-card-footer">
              <span class="badge badge-warning">paused</span>
              <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
            </div>
          </div>
        </template>
      </div>
    </div>

    <!-- Completed -->
    <div class="kanban-col">
      <div class="kanban-col-head">
        <span class="kanban-col-title">Done</span>
        <span class="kanban-col-count" x-text="completedCards().length"></span>
      </div>
      <div class="kanban-col-body">
        <template x-for="card in completedCards()" :key="card.agentId">
          <div class="kanban-card" :class="cardDoneClass(card)" @click="selectCard(card)">
            <div class="kanban-card-top">
              <span class="kanban-card-id" x-text="card.agentId"></span>
              <span class="kanban-card-status-icon" :class="card.status === 'completed' ? 'text-success' : (card.status === 'failed' ? 'text-error' : 'text-muted')"
                    x-text="card.status === 'completed' ? '\\u2713' : (card.status === 'failed' ? '\\u2717' : '\\u26D4')"></span>
            </div>
            <div class="kanban-card-task" x-text="card.task.length > 60 ? card.task.slice(0,60) + '...' : card.task"></div>
            <div class="kanban-card-footer">
              <span class="badge" :class="card.status === 'completed' ? 'badge-success' : (card.status === 'failed' ? 'badge-danger' : 'badge-neutral')" x-text="card.status"></span>
              <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
              <span class="kanban-card-elapsed" x-show="card.completedAt" x-text="duration(card)"></span>
            </div>
          </div>
        </template>
        <div class="kanban-col-empty" x-show="completedCards().length === 0">No completed tasks</div>
      </div>
    </div>
  </div>

  <!-- Spawn Task Modal -->
  <template x-if="showSpawn">
    <div class="modal" @click.self="showSpawn = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>New Agent Task</h3>
          <button class="btn btn-ghost btn-sm" @click="showSpawn = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Task Description</label>
            <textarea class="form-textarea" x-model="spawnTask" placeholder="Describe the task for the agent..." rows="3"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" x-model="spawnPriority">
              <option value="low">Low</option>
              <option value="normal" selected>Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Max Steps</label>
            <input type="number" class="form-input" x-model.number="spawnMaxSteps" min="1" max="100" placeholder="25">
          </div>
          <div class="form-error" x-show="spawnError" x-text="spawnError"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="showSpawn = false">Cancel</button>
          <button class="btn btn-primary" @click="spawnAgent()" :disabled="!spawnTask.trim()">Spawn Agent</button>
        </div>
      </div>
    </div>
  </template>

  <!-- Card Detail Modal -->
  <template x-if="selectedCard">
    <div class="modal" @click.self="selectedCard = null">
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h3 x-text="'Agent ' + selectedCard.agentId"></h3>
          <button class="btn btn-ghost btn-sm" @click="selectedCard = null">&times;</button>
        </div>
        <div class="modal-body">
          <div class="detail-item">
            <span class="detail-label">Status</span>
            <span class="badge" :class="statusBadgeClass(selectedCard.status)" x-text="selectedCard.status"></span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Priority</span>
            <span x-text="selectedCard.priority"></span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Task</span>
            <span x-text="selectedCard.task"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.progress">
            <span class="detail-label">Progress</span>
            <span x-text="selectedCard.progress"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.tokenUsage">
            <span class="detail-label">Tokens</span>
            <span class="text-mono" x-text="selectedCard.tokenUsage ? selectedCard.tokenUsage.total.toLocaleString() + ' total (' + selectedCard.tokenUsage.input.toLocaleString() + ' in / ' + selectedCard.tokenUsage.output.toLocaleString() + ' out)' : ''"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.startedAt">
            <span class="detail-label">Started</span>
            <span x-text="new Date(selectedCard.startedAt).toLocaleString()"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.completedAt">
            <span class="detail-label">Completed</span>
            <span x-text="new Date(selectedCard.completedAt).toLocaleString()"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.completedAt && selectedCard.startedAt">
            <span class="detail-label">Duration</span>
            <span x-text="duration(selectedCard)"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.error">
            <span class="detail-label">Error</span>
            <span class="text-error" x-text="selectedCard.error"></span>
          </div>
          <div x-show="selectedCard.result" style="margin-top:12px">
            <span class="detail-label" style="display:block;margin-bottom:6px">Result</span>
            <pre class="code-block" x-text="selectedCard.result" style="max-height:200px;overflow:auto"></pre>
          </div>
          <div x-show="selectedCard.filesLocked && selectedCard.filesLocked.length > 0" style="margin-top:12px">
            <span class="detail-label" style="display:block;margin-bottom:6px">Files Locked</span>
            <div class="code-block" x-text="(selectedCard.filesLocked || []).join('\\n')"></div>
          </div>
        </div>
        <div class="modal-footer">
          <template x-if="selectedCard.status === 'running'">
            <div style="display:flex;gap:6px">
              <button class="btn btn-outline btn-sm" @click="pauseAgent(selectedCard.agentId)">Pause</button>
              <button class="btn btn-danger btn-sm" @click="haltAgent(selectedCard.agentId)">Halt</button>
            </div>
          </template>
          <template x-if="selectedCard.status === 'paused'">
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" @click="resumeAgent(selectedCard.agentId)">Resume</button>
              <button class="btn btn-danger btn-sm" @click="haltAgent(selectedCard.agentId)">Halt</button>
            </div>
          </template>
          <button class="btn btn-outline btn-sm" @click="selectedCard = null">Close</button>
        </div>
      </div>
    </div>
  </template>
</div>`;

  return renderLayout(c, 'Board', body);
}
