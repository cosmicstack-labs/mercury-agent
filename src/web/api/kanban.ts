import { Hono } from 'hono';
import { generateText } from 'ai';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import type { BoardManager } from '../../core/board-manager.js';
import type { ProviderRegistry } from '../../providers/registry.js';

const app = new Hono();

// Normalize backend card statuses to the frontend-expected values
// Backend uses: pending, running, paused, completed, failed, halted
// Frontend expects: pending, running, paused, done, failed
function normalizeCardStatus(status: string): string {
  if (status === 'completed' || status === 'halted') return 'done';
  return status;
}

function normalizeCard(card: any): any {
  return {
    ...card,
    status: normalizeCardStatus(card.status),
    tokensUsed: card.tokenUsage?.total ?? card.tokensUsed,
    tokenUsage: card.tokenUsage ?? null,
    createdAt: card.createdAt ?? card.startedAt ?? new Date().toISOString(),
    labels: card.labels ?? [],
    comments: card.comments ?? [],
    attachments: card.attachments ?? [],
    parentId: card.parentId ?? null,
    dependsOn: card.dependsOn ?? [],
  };
}

function normalizeBoard(board: any): any {
  return {
    ...board,
    active: board.status === 'active',
    cards: (board.cards ?? []).map(normalizeCard),
    createdAt: typeof board.createdAt === 'number' ? new Date(board.createdAt).toISOString() : board.createdAt,
  };
}

let supervisor: SubAgentSupervisor | undefined;
let boardManager: BoardManager | undefined;
let providerRegistry: ProviderRegistry | undefined;

// Maps cardId -> agentId for tracking runtime agent execution
const cardAgentMap: Map<string, string> = new Map();
// Reverse: agentId -> { boardId, cardId }
const agentCardMap: Map<string, { boardId: string; cardId: string }> = new Map();

export function setKanbanSupervisor(s: SubAgentSupervisor): void {
  supervisor = s;
}

export function setKanbanBoardManager(bm: BoardManager): void {
  boardManager = bm;
}

export function setKanbanProviders(pr: ProviderRegistry): void {
  providerRegistry = pr;
}

export function getAgentCardMap(): Map<string, { boardId: string; cardId: string }> {
  return agentCardMap;
}

// ══════════════════════════════════════════════════════════
// Board CRUD
// ══════════════════════════════════════════════════════════

// List all boards
app.get('/api/boards', (c: any) => {
  if (!boardManager) return c.json({ boards: [], available: false });
  const boards = boardManager.getAllBoards().map(b => {
    const nb = normalizeBoard(b);
    return {
      ...nb,
      cardCount: b.cards.length,
      pendingCount: b.cards.filter((c: any) => c.status === 'pending').length,
      runningCount: b.cards.filter((c: any) => c.status === 'running').length,
      doneCount: b.cards.filter((c: any) => c.status === 'completed' || c.status === 'failed' || c.status === 'halted').length,
    };
  });
  return c.json({ boards, available: true });
});

// Get single board with cards
app.get('/api/boards/:id', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const board = boardManager.getBoard(c.req.param('id'));
  if (!board) return c.json({ error: 'Board not found' }, 404);

  const sysResources = supervisor ? supervisor.getResourceUsage() : null;
  const nb = normalizeBoard(board);
  // Transform to frontend-expected BoardResources shape
  const resources = {
    totalTokens: nb.cards.reduce((sum: number, c: any) => sum + (c.tokensUsed ?? 0), 0),
    runningCount: nb.cards.filter((c: any) => c.status === 'running').length,
    pendingCount: nb.cards.filter((c: any) => c.status === 'pending' || c.status === 'paused').length,
    doneCount: nb.cards.filter((c: any) => c.status === 'done').length,
    failedCount: nb.cards.filter((c: any) => c.status === 'failed').length,
    ...(sysResources ? { system: sysResources } : {}),
  };
  return c.json({ board: nb, resources });
});

// Create board
app.post('/api/boards', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { name, description } = body;
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return c.json({ error: 'Board name required' }, 400);
  }
  const board = boardManager.createBoard(name.trim(), (description || '').trim());
  return c.json({ ok: true, board });
});

// Update board
app.patch('/api/boards/:id', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const board = boardManager.updateBoard(c.req.param('id'), body);
  if (!board) return c.json({ error: 'Board not found' }, 404);
  return c.json({ ok: true, board });
});

// Delete board
app.delete('/api/boards/:id', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deleted = boardManager.deleteBoard(c.req.param('id'));
  if (!deleted) return c.json({ error: 'Cannot delete board (not found or has running agents)' }, 400);
  return c.json({ ok: true });
});

// Activate board
app.post('/api/boards/:id/activate', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const activated = boardManager.activateBoard(c.req.param('id'));
  if (!activated) return c.json({ error: 'Cannot activate (another board has running agents)' }, 400);
  return c.json({ ok: true });
});

// Deactivate board
app.post('/api/boards/:id/deactivate', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deactivated = boardManager.deactivateBoard(c.req.param('id'));
  if (!deactivated) return c.json({ error: 'Cannot deactivate (has running agents)' }, 400);
  return c.json({ ok: true });
});

// Generate cards from board description using LLM (with dependency tree)
app.post('/api/boards/:id/generate', async (c: any) => {
  if (!boardManager || !providerRegistry) {
    return c.json({ error: 'Not available' }, 400);
  }

  const boardId = c.req.param('id');
  const board = boardManager.getBoard(boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  if (!board.description || board.description.trim().length === 0) {
    return c.json({ error: 'Board needs a description to generate cards from' }, 400);
  }

  try {
    const provider = providerRegistry.getDefault();
    const result = await generateText({
      model: provider.getModelInstance(),
      system: `You are a project planning assistant. Given a board description, break it down into a dependency tree of task cards for an AI coding agent to execute.

Rules:
- Create parent tasks for major features/milestones and child tasks for their implementation steps
- Each task should be a single, focused unit of work
- Child tasks should reference their parent by index (0-based) in the "parentIndex" field
- Tasks with dependencies should list the indices they depend on in "dependsOnIndices"
- Root tasks (no parent) should have parentIndex: null
- Order tasks logically — parents before children, dependencies before dependents
- Assign priority: "high" for critical/blocking tasks, "normal" for standard work, "low" for nice-to-haves
- Return ONLY valid JSON, no markdown fences, no explanation

Return a JSON array of objects:
{
  "task": "description",
  "priority": "high"|"normal"|"low",
  "parentIndex": number|null,
  "dependsOnIndices": number[]
}

Example:
[
  {"task":"Set up database schema for users","priority":"high","parentIndex":null,"dependsOnIndices":[]},
  {"task":"Create user model and migrations","priority":"high","parentIndex":0,"dependsOnIndices":[0]},
  {"task":"Build authentication endpoints","priority":"high","parentIndex":0,"dependsOnIndices":[1]},
  {"task":"Set up frontend routing","priority":"normal","parentIndex":null,"dependsOnIndices":[]},
  {"task":"Build login page UI","priority":"normal","parentIndex":3,"dependsOnIndices":[2,3]}
]`,
      messages: [
        {
          role: 'user',
          content: `Board: "${board.name}"\n\nDescription:\n${board.description}\n\nGenerate task cards with parent-child relationships and dependencies for this board.`,
        },
      ],
    });

    const text = (result.text || '').trim();

    // Parse the JSON response — handle markdown fences if present
    let jsonStr = text;
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    let rawCards: Array<{ task: string; priority?: string; parentIndex?: number | null; dependsOnIndices?: number[] }>;
    try {
      rawCards = JSON.parse(jsonStr);
    } catch {
      return c.json({ error: 'Failed to parse generated cards. LLM response was not valid JSON.', raw: text }, 500);
    }

    if (!Array.isArray(rawCards) || rawCards.length === 0) {
      return c.json({ error: 'No cards generated', raw: text }, 500);
    }

    // Validate and sanitize
    const validCards = rawCards
      .filter(c => c && typeof c.task === 'string' && c.task.trim().length > 0)
      .map(c => ({
        task: c.task.trim(),
        priority: (['high', 'normal', 'low'].includes(c.priority || '') ? c.priority : 'normal') as 'high' | 'normal' | 'low',
        parentIndex: typeof c.parentIndex === 'number' ? c.parentIndex : null,
        dependsOnIndices: Array.isArray(c.dependsOnIndices) ? c.dependsOnIndices.filter(i => typeof i === 'number') : [],
      }));

    if (validCards.length === 0) {
      return c.json({ error: 'No valid cards in generated output', raw: text }, 500);
    }

    // First pass: create all cards (without deps)
    const created = boardManager.addCards(boardId, validCards.map(c => ({ task: c.task, priority: c.priority })));

    // Second pass: wire up parentId and dependsOn using the created card IDs
    for (let i = 0; i < validCards.length; i++) {
      const spec = validCards[i];
      const card = created[i];
      if (!card) continue;

      // Set parent
      if (spec.parentIndex !== null && spec.parentIndex >= 0 && spec.parentIndex < created.length && spec.parentIndex !== i) {
        const parentCard = created[spec.parentIndex];
        if (parentCard) {
          boardManager.setParent(boardId, card.id, parentCard.id);
        }
      }

      // Set dependsOn
      for (const depIdx of spec.dependsOnIndices) {
        if (depIdx >= 0 && depIdx < created.length && depIdx !== i) {
          const depCard = created[depIdx];
          if (depCard) {
            boardManager.addDependency(boardId, card.id, depCard.id);
          }
        }
      }
    }

    // Re-fetch cards after wiring deps
    const updatedBoard = boardManager.getBoard(boardId);
    const finalCards = updatedBoard ? updatedBoard.cards.slice(-created.length).map(normalizeCard) : created.map(normalizeCard);

    return c.json({ ok: true, cards: finalCards, count: created.length });
  } catch (err: any) {
    return c.json({ error: 'Generation failed: ' + (err.message || 'unknown error') }, 500);
  }
});

// ══════════════════════════════════════════════════════════
// Card CRUD
// ══════════════════════════════════════════════════════════

// Add card to board
app.post('/api/boards/:id/cards', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { task, priority } = body;
  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return c.json({ error: 'Task description required' }, 400);
  }
  const card = boardManager.addCard(c.req.param('id'), task.trim(), priority || 'normal');
  if (!card) return c.json({ error: 'Board not found' }, 404);
  return c.json({ ok: true, card: normalizeCard(card) });
});

// Add multiple cards
app.post('/api/boards/:id/cards/bulk', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { cards } = body;
  if (!Array.isArray(cards) || cards.length === 0) {
    return c.json({ error: 'Cards array required' }, 400);
  }
  const created = boardManager.addCards(c.req.param('id'), cards);
  if (created.length === 0) return c.json({ error: 'Board not found' }, 404);
  return c.json({ ok: true, cards: created.map(normalizeCard) });
});

// Update card
app.patch('/api/boards/:boardId/cards/:cardId', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const card = boardManager.updateCard(c.req.param('boardId'), c.req.param('cardId'), body);
  if (!card) return c.json({ error: 'Card not found' }, 404);
  return c.json({ ok: true, card: normalizeCard(card) });
});

// Delete card
app.delete('/api/boards/:boardId/cards/:cardId', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deleted = boardManager.deleteCard(c.req.param('boardId'), c.req.param('cardId'));
  if (!deleted) return c.json({ error: 'Cannot delete card (not found or running)' }, 400);
  return c.json({ ok: true });
});

// Reorder cards
app.post('/api/boards/:id/cards/reorder', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { cardIds } = body;
  if (!Array.isArray(cardIds)) return c.json({ error: 'cardIds array required' }, 400);
  const ok = boardManager.reorderCards(c.req.param('id'), cardIds);
  return c.json({ ok });
});

// Clear done cards
app.post('/api/boards/:id/cards/clear-done', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const cleared = boardManager.clearDoneCards(c.req.param('id'));
  return c.json({ ok: true, cleared });
});

// ══════════════════════════════════════════════════════════
// Card Execution (spawn agent for a card)
// ══════════════════════════════════════════════════════════

// Execute a single card
app.post('/api/boards/:boardId/cards/:cardId/run', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const boardId = c.req.param('boardId');
  const cardId = c.req.param('cardId');

  const board = boardManager.getBoard(boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);
  if (board.status !== 'active') return c.json({ error: 'Board is not active. Activate it first.' }, 400);

  const card = board.cards.find(cc => cc.id === cardId);
  if (!card) return c.json({ error: 'Card not found' }, 404);
  if (card.status === 'running' || card.status === 'paused') {
    return c.json({ error: 'Card is already running' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));

  const agentId = await supervisor.spawn({
    task: card.task,
    priority: card.priority,
    maxSteps: body.maxSteps || 25,
    sourceChannelType: 'web',
    sourceChannelId: `board:${boardId}`,
  });

  // Track mapping
  cardAgentMap.set(cardId, agentId);
  agentCardMap.set(agentId, { boardId, cardId });

  // Update card status
  boardManager.updateCard(boardId, cardId, {
    status: 'running',
    startedAt: Date.now(),
    progress: 'Spawned agent ' + agentId,
  });

  return c.json({ ok: true, agentId });
});

// Execute all pending cards on active board
app.post('/api/boards/:id/run-all', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const boardId = c.req.param('id');
  const board = boardManager.getBoard(boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);
  if (board.status !== 'active') return c.json({ error: 'Board is not active' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const pending = board.cards.filter(c => c.status === 'pending').sort((a, b) => a.order - b.order);
  const spawned: string[] = [];

  for (const card of pending) {
    const agentId = await supervisor.spawn({
      task: card.task,
      priority: card.priority,
      maxSteps: body.maxSteps || 25,
      sourceChannelType: 'web',
      sourceChannelId: `board:${boardId}`,
    });

    cardAgentMap.set(card.id, agentId);
    agentCardMap.set(agentId, { boardId, cardId: card.id });

    boardManager.updateCard(boardId, card.id, {
      status: 'running',
      startedAt: Date.now(),
      progress: 'Spawned agent ' + agentId,
    });

    spawned.push(agentId);
  }

  return c.json({ ok: true, spawned });
});

// Halt a running card
app.post('/api/boards/:boardId/cards/:cardId/halt', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const cardId = c.req.param('cardId');
  const agentId = cardAgentMap.get(cardId);
  if (!agentId) return c.json({ error: 'No running agent for this card' }, 400);

  const halted = await supervisor.halt(agentId);
  if (halted) {
    boardManager.updateCard(c.req.param('boardId'), cardId, {
      status: 'halted',
      completedAt: Date.now(),
      progress: 'Halted by user',
    });
    cardAgentMap.delete(cardId);
    agentCardMap.delete(agentId);
  }
  return c.json({ ok: halted });
});

// Halt all running cards on a board
app.post('/api/boards/:id/halt-all', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const boardId = c.req.param('id');
  const board = boardManager.getBoard(boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);

  for (const card of board.cards) {
    if (card.status === 'running' || card.status === 'paused') {
      const agentId = cardAgentMap.get(card.id);
      if (agentId) {
        await supervisor.halt(agentId);
        cardAgentMap.delete(card.id);
        agentCardMap.delete(agentId);
      }
      boardManager.updateCard(boardId, card.id, {
        status: 'halted',
        completedAt: Date.now(),
        progress: 'Halted by user',
      });
    }
  }
  return c.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// Smart Execute (dependency-aware)
// ══════════════════════════════════════════════════════════

// Get execution plan (preview)
app.get('/api/boards/:id/execution-plan', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const boardId = c.req.param('id');
  const batches = boardManager.getSmartExecutionOrder(boardId);
  return c.json({
    ok: true,
    batches: batches.map((batch, i) => ({
      wave: i + 1,
      cards: batch.map(normalizeCard),
    })),
    totalBatches: batches.length,
    totalCards: batches.reduce((sum, b) => sum + b.length, 0),
  });
});

// Smart Execute: run cards in dependency order
app.post('/api/boards/:id/smart-execute', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const boardId = c.req.param('id');
  const board = boardManager.getBoard(boardId);
  if (!board) return c.json({ error: 'Board not found' }, 404);
  if (board.status !== 'active') return c.json({ error: 'Board is not active' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const batches = boardManager.getSmartExecutionOrder(boardId);
  if (batches.length === 0) return c.json({ ok: true, message: 'No pending cards to execute', spawned: [] });

  // Start the first batch — subsequent batches auto-start via cascade
  const firstBatch = batches[0];
  const spawned: string[] = [];

  for (const card of firstBatch) {
    const agentId = await supervisor.spawn({
      task: card.task,
      priority: card.priority,
      maxSteps: body.maxSteps || 25,
      sourceChannelType: 'web',
      sourceChannelId: `board:${boardId}`,
    });

    cardAgentMap.set(card.id, agentId);
    agentCardMap.set(agentId, { boardId, cardId: card.id });

    boardManager.updateCard(boardId, card.id, {
      status: 'running',
      startedAt: Date.now(),
      progress: `Wave 1 — Spawned agent ${agentId}`,
    });

    spawned.push(agentId);
  }

  return c.json({
    ok: true,
    spawned,
    plan: {
      totalBatches: batches.length,
      currentBatch: 1,
      remainingBatches: batches.length - 1,
      nextBatchCards: batches.length > 1 ? batches[1].map(c => c.id) : [],
    },
  });
});

// Check and cascade: called when a card completes to auto-start unblocked children
app.post('/api/boards/:boardId/cards/:cardId/cascade', async (c: any) => {
  if (!boardManager || !supervisor) return c.json({ error: 'Not available' }, 400);

  const boardId = c.req.param('boardId');
  const board = boardManager.getBoard(boardId);
  if (!board || board.status !== 'active') return c.json({ ok: true, cascaded: [] });

  const body = await c.req.json().catch(() => ({}));
  const unblocked = boardManager.getUnblockedCards(boardId);
  const cascaded: string[] = [];

  for (const card of unblocked) {
    const agentId = await supervisor.spawn({
      task: card.task,
      priority: card.priority,
      maxSteps: body.maxSteps || 25,
      sourceChannelType: 'web',
      sourceChannelId: `board:${boardId}`,
    });

    cardAgentMap.set(card.id, agentId);
    agentCardMap.set(agentId, { boardId, cardId: card.id });

    boardManager.updateCard(boardId, card.id, {
      status: 'running',
      startedAt: Date.now(),
      progress: `Auto-cascaded — Spawned agent ${agentId}`,
    });

    cascaded.push(card.id);
  }

  return c.json({ ok: true, cascaded });
});

// ══════════════════════════════════════════════════════════
// Card Comments
// ══════════════════════════════════════════════════════════

app.get('/api/boards/:boardId/cards/:cardId/comments', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const card = boardManager.getCard(c.req.param('boardId'), c.req.param('cardId'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  return c.json({ comments: card.comments ?? [] });
});

app.post('/api/boards/:boardId/cards/:cardId/comments', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { content, author, authorName } = body;
  if (!content || typeof content !== 'string') return c.json({ error: 'Content required' }, 400);
  const comment = boardManager.addComment(
    c.req.param('boardId'),
    c.req.param('cardId'),
    author || 'user',
    authorName || 'Admin',
    content.trim(),
  );
  if (!comment) return c.json({ error: 'Card not found' }, 404);
  return c.json({ ok: true, comment });
});

app.delete('/api/boards/:boardId/cards/:cardId/comments/:commentId', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deleted = boardManager.deleteComment(c.req.param('boardId'), c.req.param('cardId'), c.req.param('commentId'));
  if (!deleted) return c.json({ error: 'Comment not found' }, 404);
  return c.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// Card Attachments
// ══════════════════════════════════════════════════════════

app.get('/api/boards/:boardId/cards/:cardId/attachments', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const card = boardManager.getCard(c.req.param('boardId'), c.req.param('cardId'));
  if (!card) return c.json({ error: 'Card not found' }, 404);
  return c.json({ attachments: card.attachments ?? [] });
});

app.post('/api/boards/:boardId/cards/:cardId/attachments', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { name, path, type, size, addedBy } = body;
  if (!name || !path) return c.json({ error: 'name and path required' }, 400);
  const attachment = boardManager.addAttachment(c.req.param('boardId'), c.req.param('cardId'), {
    name,
    path,
    type: type || 'other',
    size,
    addedBy: addedBy || 'agent',
  });
  if (!attachment) return c.json({ error: 'Card not found' }, 404);
  return c.json({ ok: true, attachment });
});

app.delete('/api/boards/:boardId/cards/:cardId/attachments/:attachmentId', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deleted = boardManager.deleteAttachment(c.req.param('boardId'), c.req.param('cardId'), c.req.param('attachmentId'));
  if (!deleted) return c.json({ error: 'Attachment not found' }, 404);
  return c.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// Card Labels
// ══════════════════════════════════════════════════════════

app.post('/api/boards/:boardId/cards/:cardId/labels', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { name, color } = body;
  if (!name || !color) return c.json({ error: 'name and color required' }, 400);
  const label = boardManager.addLabel(c.req.param('boardId'), c.req.param('cardId'), name, color);
  if (!label) return c.json({ error: 'Card not found' }, 404);
  return c.json({ ok: true, label });
});

app.delete('/api/boards/:boardId/cards/:cardId/labels/:labelId', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const deleted = boardManager.removeLabel(c.req.param('boardId'), c.req.param('cardId'), c.req.param('labelId'));
  if (!deleted) return c.json({ error: 'Label not found' }, 404);
  return c.json({ ok: true });
});

// ══════════════════════════════════════════════════════════
// Card Dependencies
// ══════════════════════════════════════════════════════════

app.post('/api/boards/:boardId/cards/:cardId/parent', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { parentId } = body;
  const ok = boardManager.setParent(c.req.param('boardId'), c.req.param('cardId'), parentId ?? null);
  if (!ok) return c.json({ error: 'Invalid parent (not found, self-reference, or circular)' }, 400);
  return c.json({ ok: true });
});

app.post('/api/boards/:boardId/cards/:cardId/dependencies', async (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { dependsOnCardId } = body;
  if (!dependsOnCardId) return c.json({ error: 'dependsOnCardId required' }, 400);
  const ok = boardManager.addDependency(c.req.param('boardId'), c.req.param('cardId'), dependsOnCardId);
  if (!ok) return c.json({ error: 'Invalid dependency (not found, self-reference, or circular)' }, 400);
  return c.json({ ok: true });
});

app.delete('/api/boards/:boardId/cards/:cardId/dependencies/:depId', (c: any) => {
  if (!boardManager) return c.json({ error: 'Not available' }, 400);
  const ok = boardManager.removeDependency(c.req.param('boardId'), c.req.param('cardId'), c.req.param('depId'));
  if (!ok) return c.json({ error: 'Dependency not found' }, 404);
  return c.json({ ok: true });
});

export default app;
