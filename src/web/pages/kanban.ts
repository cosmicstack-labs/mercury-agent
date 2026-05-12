import { Context } from 'hono';
import { renderLayout } from './layout.js';

export function renderKanban(c: Context): string {
  const body = `
<div x-data="kanbanBoard()" x-init="init()" class="kanban-page">

  <!-- No boards: landing state -->
  <template x-if="!activeBoardId && boards.length === 0 && !loading">
    <div class="kanban-landing">
      <div class="kanban-landing-inner">
        <div class="kanban-landing-icon">&#9881;</div>
        <h2>No Boards Yet</h2>
        <p class="text-muted">Create your first board to start organizing agent tasks.</p>
        <button class="btn btn-primary" @click="showCreateBoard = true" style="margin-top:16px">+ Create Board</button>
      </div>
    </div>
  </template>

  <!-- Board list (no board selected) -->
  <template x-if="!activeBoardId && boards.length > 0">
    <div class="kanban-board-list-page">
      <div class="kanban-board-list-header">
        <h1>Boards</h1>
        <button class="btn btn-primary btn-sm" @click="showCreateBoard = true">+ New Board</button>
      </div>
      <div class="kanban-board-grid">
        <template x-for="b in boards" :key="b.id">
          <div class="kanban-board-card" :class="{ 'kanban-board-card-active': b.status === 'active' }" @click="openBoard(b.id)">
            <div class="kanban-board-card-head">
              <span class="kanban-board-card-name" x-text="b.name"></span>
              <span class="badge" :class="b.status === 'active' ? 'badge-success' : 'badge-neutral'" x-text="b.status"></span>
            </div>
            <div class="kanban-board-card-desc" x-text="b.description || 'No description'" :class="{ 'text-muted': !b.description }"></div>
            <div class="kanban-board-card-stats">
              <span x-show="b.pendingCount > 0"><span x-text="b.pendingCount"></span> queued</span>
              <span x-show="b.runningCount > 0" class="text-accent"><span x-text="b.runningCount"></span> running</span>
              <span x-show="b.doneCount > 0" class="text-success"><span x-text="b.doneCount"></span> done</span>
              <span x-show="b.cardCount === 0" class="text-muted">No cards</span>
            </div>
            <div class="kanban-board-card-meta" x-text="'Created ' + formatDate(b.createdAt)"></div>
          </div>
        </template>
      </div>
    </div>
  </template>

  <!-- Active board detail view -->
  <template x-if="activeBoardId && currentBoard">
    <div class="kanban-detail">

      <!-- Board header -->
      <div class="kanban-header">
        <div class="kanban-header-left">
          <button class="btn btn-ghost btn-sm" @click="closeBoard()" title="Back to boards">&larr;</button>
          <div>
            <h1 class="kanban-title" x-text="currentBoard.name"></h1>
            <p class="kanban-subtitle" x-show="currentBoard.description" x-text="currentBoard.description"></p>
          </div>
          <span class="badge" :class="currentBoard.status === 'active' ? 'badge-success' : 'badge-neutral'" x-text="currentBoard.status"></span>
          <div class="kanban-resource-bar" x-show="resources">
            <span class="kanban-resource-chip">
              <span class="kanban-resource-dot" :class="resources && resources.activeAgents > 0 ? 'dot-green' : 'dot-gray'"></span>
              <span x-text="(resources ? resources.activeAgents : 0) + '/' + (resources ? resources.maxConcurrentAgents : 0) + ' agents'"></span>
            </span>
          </div>
        </div>
        <div class="kanban-header-actions">
          <button class="btn btn-sm btn-outline" @click="activateBoard()" x-show="currentBoard.status === 'inactive'" title="Activate this board">Activate</button>
          <button class="btn btn-sm btn-outline" @click="deactivateBoard()" x-show="currentBoard.status === 'active' && runningCount === 0" title="Deactivate">Deactivate</button>
          <button class="btn btn-sm btn-outline" @click="clearDone()" x-show="doneCount > 0">Clear Done (<span x-text="doneCount"></span>)</button>
          <button class="btn btn-sm btn-primary" @click="runAllPending()" x-show="currentBoard.status === 'active' && pendingCount > 0" :disabled="runningCount > 0">Run All</button>
          <button class="btn btn-sm btn-danger" @click="haltAll()" x-show="runningCount > 0">Halt All</button>
          <button class="btn btn-sm btn-primary" @click="showAddCard = true">+ Card</button>
          <button class="btn btn-sm btn-outline" @click="generateCards()" :disabled="generating || !currentBoard.description" x-show="currentBoard.status === 'active'" title="Generate cards from board description">
            <template x-if="generating"><span class="step-spinner-sm"></span></template>
            <span x-text="generating ? 'Generating...' : 'Generate'"></span>
          </button>
          <button class="btn btn-ghost btn-sm" @click="showBoardMenu = !showBoardMenu" title="Board settings">&#8942;</button>
          <div class="kanban-board-menu" x-show="showBoardMenu" @click.outside="showBoardMenu = false">
            <button class="kanban-menu-item" @click="editBoardName = currentBoard.name; editBoardDesc = currentBoard.description; showEditBoard = true; showBoardMenu = false">Edit Board</button>
            <button class="kanban-menu-item kanban-menu-danger" @click="confirmDeleteBoard(); showBoardMenu = false">Delete Board</button>
          </div>
        </div>
      </div>

      <!-- Kanban Columns -->
      <div class="kanban-columns">

        <!-- Pending / Queued -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span class="kanban-col-title">Queued</span>
            <span class="kanban-col-count" x-text="cardsByStatus('pending').length"></span>
          </div>
          <div class="kanban-col-body">
            <template x-for="card in cardsByStatus('pending')" :key="card.id">
              <div class="kanban-card" @click="selectCard(card)">
                <div class="kanban-card-top">
                  <span class="kanban-card-id" x-text="card.id"></span>
                  <span class="badge badge-neutral" x-text="card.priority"></span>
                </div>
                <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
                <div class="kanban-card-footer">
                  <button class="btn btn-xs btn-primary" @click.stop="runCard(card.id)" x-show="currentBoard.status === 'active'">Run</button>
                  <button class="btn btn-xs btn-ghost" @click.stop="editCard(card)" title="Edit">&#9998;</button>
                  <button class="btn btn-xs btn-ghost text-error" @click.stop="deleteCard(card.id)" title="Delete">&times;</button>
                </div>
              </div>
            </template>
            <div class="kanban-col-empty" x-show="cardsByStatus('pending').length === 0">No queued cards</div>
          </div>
        </div>

        <!-- Running -->
        <div class="kanban-col kanban-col-active">
          <div class="kanban-col-head">
            <span class="kanban-col-title">Running</span>
            <span class="kanban-col-count kanban-col-count-active" x-text="cardsByStatus('running').length"></span>
          </div>
          <div class="kanban-col-body">
            <template x-for="card in cardsByStatus('running')" :key="card.id">
              <div class="kanban-card kanban-card-running" @click="selectCard(card)">
                <div class="kanban-card-top">
                  <span class="kanban-card-id" x-text="card.id"></span>
                  <span class="step-spinner-sm"></span>
                </div>
                <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
                <div class="kanban-card-progress" x-show="card.progress" x-text="card.progress"></div>
                <div class="kanban-card-footer">
                  <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
                  <span class="kanban-card-elapsed" x-text="elapsed(card)"></span>
                  <button class="btn btn-xs btn-danger" @click.stop="haltCard(card.id)" style="margin-left:auto">Halt</button>
                </div>
              </div>
            </template>
            <div class="kanban-col-empty" x-show="cardsByStatus('running').length === 0">No running cards</div>
          </div>
        </div>

        <!-- Paused -->
        <div class="kanban-col" x-show="cardsByStatus('paused').length > 0">
          <div class="kanban-col-head">
            <span class="kanban-col-title">Paused</span>
            <span class="kanban-col-count" x-text="cardsByStatus('paused').length"></span>
          </div>
          <div class="kanban-col-body">
            <template x-for="card in cardsByStatus('paused')" :key="card.id">
              <div class="kanban-card kanban-card-paused" @click="selectCard(card)">
                <div class="kanban-card-id" x-text="card.id"></div>
                <div class="kanban-card-task" x-text="card.task.length > 80 ? card.task.slice(0,80) + '...' : card.task"></div>
                <div class="kanban-card-footer">
                  <span class="badge badge-warning">paused</span>
                  <span class="kanban-card-tokens" x-show="card.tokenUsage" x-text="formatTokens(card.tokenUsage)"></span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Done -->
        <div class="kanban-col">
          <div class="kanban-col-head">
            <span class="kanban-col-title">Done</span>
            <span class="kanban-col-count" x-text="completedCards().length"></span>
          </div>
          <div class="kanban-col-body">
            <template x-for="card in completedCards()" :key="card.id">
              <div class="kanban-card" :class="cardDoneClass(card)" @click="selectCard(card)">
                <div class="kanban-card-top">
                  <span class="kanban-card-id" x-text="card.id"></span>
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
            <div class="kanban-col-empty" x-show="completedCards().length === 0">No completed cards</div>
          </div>
        </div>
      </div>
    </div>
  </template>

  <!-- ═══ Create Board Modal ═══ -->
  <template x-if="showCreateBoard">
    <div class="modal" @click.self="showCreateBoard = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>New Board</h3>
          <button class="btn btn-ghost btn-sm" @click="showCreateBoard = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" x-model="newBoardName" placeholder="e.g. Sprint 4, Website Redesign" autofocus>
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" x-model="newBoardDesc" placeholder="Describe the board's purpose. Used to auto-generate task cards..." rows="4"></textarea>
          </div>
          <div class="kanban-generate-hint" x-show="newBoardDesc.trim().length > 0 && !generating">
            <svg style="width:14px;height:14px;flex-shrink:0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
            <span>You can generate initial cards from this description after creating the board.</span>
          </div>
          <div class="kanban-generating" x-show="generating">
            <span class="step-spinner-sm"></span>
            <span>Generating cards from description...</span>
          </div>
          <div class="form-error" x-show="createError" x-text="createError"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="showCreateBoard = false" :disabled="generating">Cancel</button>
          <button class="btn btn-secondary" @click="createBoard(false)" :disabled="!newBoardName.trim() || generating">Create Only</button>
          <button class="btn btn-primary" @click="createBoard(true)" :disabled="!newBoardName.trim() || !newBoardDesc.trim() || generating">Create & Generate Cards</button>
        </div>
      </div>
    </div>
  </template>

  <!-- ═══ Edit Board Modal ═══ -->
  <template x-if="showEditBoard && currentBoard">
    <div class="modal" @click.self="showEditBoard = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Edit Board</h3>
          <button class="btn btn-ghost btn-sm" @click="showEditBoard = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Name</label>
            <input type="text" class="form-input" x-model="editBoardName">
          </div>
          <div class="form-group">
            <label class="form-label">Description</label>
            <textarea class="form-textarea" x-model="editBoardDesc" rows="3"></textarea>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="showEditBoard = false">Cancel</button>
          <button class="btn btn-primary" @click="saveBoard()">Save</button>
        </div>
      </div>
    </div>
  </template>

  <!-- ═══ Add Card Modal ═══ -->
  <template x-if="showAddCard">
    <div class="modal" @click.self="showAddCard = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3>Add Card</h3>
          <button class="btn btn-ghost btn-sm" @click="showAddCard = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Task Description</label>
            <textarea class="form-textarea" x-model="addCardTask" placeholder="Describe the task for the agent..." rows="3"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" x-model="addCardPriority">
              <option value="low">Low</option>
              <option value="normal" selected>Normal</option>
              <option value="high">High</option>
            </select>
          </div>
          <div class="form-error" x-show="addCardError" x-text="addCardError"></div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="showAddCard = false">Cancel</button>
          <button class="btn btn-primary" @click="addCard()" :disabled="!addCardTask.trim()">Add Card</button>
        </div>
      </div>
    </div>
  </template>

  <!-- ═══ Edit Card Modal ═══ -->
  <template x-if="showEditCard && editingCard">
    <div class="modal" @click.self="showEditCard = false">
      <div class="modal-content">
        <div class="modal-header">
          <h3 x-text="'Edit ' + editingCard.id"></h3>
          <button class="btn btn-ghost btn-sm" @click="showEditCard = false">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Task Description</label>
            <textarea class="form-textarea" x-model="editingCard.task" rows="3"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Priority</label>
            <select class="form-select" x-model="editingCard.priority">
              <option value="low">Low</option>
              <option value="normal">Normal</option>
              <option value="high">High</option>
            </select>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn btn-outline" @click="showEditCard = false">Cancel</button>
          <button class="btn btn-primary" @click="saveCard()">Save</button>
        </div>
      </div>
    </div>
  </template>

  <!-- ═══ Card Detail Modal ═══ -->
  <template x-if="selectedCard">
    <div class="modal" @click.self="selectedCard = null">
      <div class="modal-content" style="max-width:560px">
        <div class="modal-header">
          <h3 x-text="'Card ' + selectedCard.id"></h3>
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
            <span x-text="selectedCard.startedAt ? new Date(selectedCard.startedAt).toLocaleString() : ''"></span>
          </div>
          <div class="detail-item" x-show="selectedCard.completedAt">
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
        </div>
        <div class="modal-footer">
          <template x-if="selectedCard.status === 'running'">
            <button class="btn btn-danger btn-sm" @click="haltCard(selectedCard.id); selectedCard = null">Halt</button>
          </template>
          <template x-if="selectedCard.status === 'pending'">
            <div style="display:flex;gap:6px">
              <button class="btn btn-primary btn-sm" @click="runCard(selectedCard.id); selectedCard = null" x-show="currentBoard && currentBoard.status === 'active'">Run</button>
              <button class="btn btn-ghost btn-sm" @click="editCard(selectedCard); selectedCard = null">Edit</button>
              <button class="btn btn-danger btn-sm" @click="deleteCard(selectedCard.id); selectedCard = null">Delete</button>
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
