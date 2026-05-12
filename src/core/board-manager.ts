import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { Board, BoardCard, BoardStatus, SubAgentStatus, SubAgentPriority, CardComment, CardAttachment, CardLabel } from '../types/agent.js';

const BOARDS_FILE = 'boards.json';

export class BoardManager {
  private boards: Map<string, Board> = new Map();
  private counter: number = 0;
  private cardCounter: number = 0;

  load(): void {
    const filePath = this.getFilePath();
    if (existsSync(filePath)) {
      try {
        const data = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(data);
        for (const board of parsed.boards || []) {
          this.boards.set(board.id, board);
        }
        this.counter = parsed.counter || 0;
        this.cardCounter = parsed.cardCounter || 0;
        logger.info({ count: this.boards.size }, 'Board manager loaded');
      } catch (err) {
        logger.warn({ err }, 'Failed to load boards, starting fresh');
        this.boards.clear();
      }
    }
  }

  save(): void {
    const dir = join(getMercuryHome(), 'memory');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const filePath = this.getFilePath();
    const data = {
      counter: this.counter,
      cardCounter: this.cardCounter,
      boards: [...this.boards.values()],
    };
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ── Board CRUD ──

  createBoard(name: string, description: string): Board {
    this.counter++;
    const id = `b${this.counter}`;
    const now = Date.now();

    // If no boards exist, make this one active
    const hasActive = [...this.boards.values()].some(b => b.status === 'active');

    const board: Board = {
      id,
      name,
      description,
      status: hasActive ? 'inactive' : 'active',
      createdAt: now,
      updatedAt: now,
      cards: [],
    };
    this.boards.set(id, board);
    this.save();
    logger.info({ boardId: id, name }, 'Board created');
    return board;
  }

  getBoard(id: string): Board | undefined {
    return this.boards.get(id);
  }

  getAllBoards(): Board[] {
    return [...this.boards.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getActiveBoard(): Board | undefined {
    return [...this.boards.values()].find(b => b.status === 'active');
  }

  updateBoard(id: string, partial: { name?: string; description?: string }): Board | undefined {
    const board = this.boards.get(id);
    if (!board) return undefined;
    if (partial.name !== undefined) board.name = partial.name;
    if (partial.description !== undefined) board.description = partial.description;
    board.updatedAt = Date.now();
    this.save();
    return board;
  }

  deleteBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;
    if (board.status === 'active') {
      // Cannot delete active board if it has running cards
      const hasRunning = board.cards.some(c => c.status === 'running' || c.status === 'paused');
      if (hasRunning) return false;
    }
    this.boards.delete(id);
    this.save();
    logger.info({ boardId: id }, 'Board deleted');
    return true;
  }

  activateBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board) return false;

    // Check if current active board has running agents
    const currentActive = this.getActiveBoard();
    if (currentActive && currentActive.id !== id) {
      const hasRunning = currentActive.cards.some(c => c.status === 'running' || c.status === 'paused');
      if (hasRunning) return false; // Can't switch while agents are running
      currentActive.status = 'inactive';
      currentActive.updatedAt = Date.now();
    }

    board.status = 'active';
    board.updatedAt = Date.now();
    this.save();
    logger.info({ boardId: id }, 'Board activated');
    return true;
  }

  deactivateBoard(id: string): boolean {
    const board = this.boards.get(id);
    if (!board || board.status !== 'active') return false;
    const hasRunning = board.cards.some(c => c.status === 'running' || c.status === 'paused');
    if (hasRunning) return false;
    board.status = 'inactive';
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ── Card CRUD ──

  nextCardId(): string {
    this.cardCounter++;
    return `c${this.cardCounter}`;
  }

  addCard(boardId: string, task: string, priority: SubAgentPriority = 'normal'): BoardCard | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;

    const maxOrder = board.cards.length > 0
      ? Math.max(...board.cards.map(c => c.order))
      : -1;

    const card: BoardCard = {
      id: this.nextCardId(),
      task,
      status: 'pending',
      priority,
      order: maxOrder + 1,
      filesLocked: [],
    };
    board.cards.push(card);
    board.updatedAt = Date.now();
    this.save();
    return card;
  }

  addCards(boardId: string, cards: Array<{ task: string; priority?: SubAgentPriority }>): BoardCard[] {
    const board = this.boards.get(boardId);
    if (!board) return [];

    let maxOrder = board.cards.length > 0
      ? Math.max(...board.cards.map(c => c.order))
      : -1;

    const created: BoardCard[] = [];
    for (const c of cards) {
      maxOrder++;
      const card: BoardCard = {
        id: this.nextCardId(),
        task: c.task,
        status: 'pending',
        priority: c.priority || 'normal',
        order: maxOrder,
        filesLocked: [],
      };
      board.cards.push(card);
      created.push(card);
    }
    board.updatedAt = Date.now();
    this.save();
    return created;
  }

  getCard(boardId: string, cardId: string): BoardCard | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    return board.cards.find(c => c.id === cardId);
  }

  updateCard(boardId: string, cardId: string, partial: Partial<Pick<BoardCard, 'task' | 'priority' | 'order' | 'status' | 'progress' | 'result' | 'error' | 'tokenUsage' | 'startedAt' | 'completedAt' | 'filesLocked'>>): BoardCard | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return undefined;
    Object.assign(card, partial);
    board.updatedAt = Date.now();
    this.save();
    return card;
  }

  deleteCard(boardId: string, cardId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    const idx = board.cards.findIndex(c => c.id === cardId);
    if (idx === -1) return false;
    const card = board.cards[idx];
    // Don't delete running cards
    if (card.status === 'running' || card.status === 'paused') return false;
    board.cards.splice(idx, 1);
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  reorderCards(boardId: string, cardIds: string[]): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    for (let i = 0; i < cardIds.length; i++) {
      const card = board.cards.find(c => c.id === cardIds[i]);
      if (card) card.order = i;
    }
    board.cards.sort((a, b) => a.order - b.order);
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  getCardsByStatus(boardId: string, status: SubAgentStatus): BoardCard[] {
    const board = this.boards.get(boardId);
    if (!board) return [];
    return board.cards.filter(c => c.status === status).sort((a, b) => a.order - b.order);
  }

  clearDoneCards(boardId: string): number {
    const board = this.boards.get(boardId);
    if (!board) return 0;
    const before = board.cards.length;
    board.cards = board.cards.filter(c => c.status !== 'completed' && c.status !== 'failed' && c.status !== 'halted');
    const cleared = before - board.cards.length;
    if (cleared > 0) {
      board.updatedAt = Date.now();
      this.save();
    }
    return cleared;
  }

  // ── Card Comments ──

  addComment(boardId: string, cardId: string, author: 'user' | 'agent', authorName: string, content: string): CardComment | undefined {
    const card = this.getCard(boardId, cardId);
    if (!card) return undefined;
    if (!card.comments) card.comments = [];
    const comment: CardComment = {
      id: `cmt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      author,
      authorName,
      content,
      timestamp: Date.now(),
    };
    card.comments.push(comment);
    const board = this.boards.get(boardId)!;
    board.updatedAt = Date.now();
    this.save();
    return comment;
  }

  deleteComment(boardId: string, cardId: string, commentId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.comments) return false;
    const idx = card.comments.findIndex(c => c.id === commentId);
    if (idx === -1) return false;
    card.comments.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ── Card Attachments ──

  addAttachment(boardId: string, cardId: string, attachment: Omit<CardAttachment, 'id' | 'addedAt'>): CardAttachment | undefined {
    const card = this.getCard(boardId, cardId);
    if (!card) return undefined;
    if (!card.attachments) card.attachments = [];
    const full: CardAttachment = {
      ...attachment,
      id: `att_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      addedAt: Date.now(),
    };
    card.attachments.push(full);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return full;
  }

  deleteAttachment(boardId: string, cardId: string, attachmentId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.attachments) return false;
    const idx = card.attachments.findIndex(a => a.id === attachmentId);
    if (idx === -1) return false;
    card.attachments.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ── Card Labels ──

  addLabel(boardId: string, cardId: string, name: string, color: string): CardLabel | undefined {
    const card = this.getCard(boardId, cardId);
    if (!card) return undefined;
    if (!card.labels) card.labels = [];
    // Don't add duplicate labels
    if (card.labels.some(l => l.name === name)) return card.labels.find(l => l.name === name);
    const label: CardLabel = {
      id: `lbl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      color,
    };
    card.labels.push(label);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return label;
  }

  removeLabel(boardId: string, cardId: string, labelId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.labels) return false;
    const idx = card.labels.findIndex(l => l.id === labelId);
    if (idx === -1) return false;
    card.labels.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return true;
  }

  // ── Card Dependencies ──

  setParent(boardId: string, cardId: string, parentId: string | null): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return false;
    if (parentId) {
      // Validate parent exists and is not self or a descendant
      if (parentId === cardId) return false;
      const parent = board.cards.find(c => c.id === parentId);
      if (!parent) return false;
      // Prevent circular: walk up from parentId, ensure we never hit cardId
      let current: string | undefined = parentId;
      while (current) {
        if (current === cardId) return false; // circular
        const p = board.cards.find(c => c.id === current);
        current = p?.parentId;
      }
      card.parentId = parentId;
      // Auto-add parent to dependsOn
      if (!card.dependsOn) card.dependsOn = [];
      if (!card.dependsOn.includes(parentId)) card.dependsOn.push(parentId);
    } else {
      delete card.parentId;
    }
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  addDependency(boardId: string, cardId: string, dependsOnCardId: string): boolean {
    const board = this.boards.get(boardId);
    if (!board) return false;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return false;
    if (cardId === dependsOnCardId) return false;
    if (!board.cards.find(c => c.id === dependsOnCardId)) return false;
    // Check for circular dependency
    if (this.wouldCreateCycle(board, dependsOnCardId, cardId)) return false;
    if (!card.dependsOn) card.dependsOn = [];
    if (!card.dependsOn.includes(dependsOnCardId)) card.dependsOn.push(dependsOnCardId);
    board.updatedAt = Date.now();
    this.save();
    return true;
  }

  removeDependency(boardId: string, cardId: string, dependsOnCardId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.dependsOn) return false;
    const idx = card.dependsOn.indexOf(dependsOnCardId);
    if (idx === -1) return false;
    card.dependsOn.splice(idx, 1);
    if (card.dependsOn.length === 0) delete card.dependsOn;
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save();
    return true;
  }

  getChildren(boardId: string, cardId: string): BoardCard[] {
    const board = this.boards.get(boardId);
    if (!board) return [];
    return board.cards.filter(c => c.parentId === cardId);
  }

  /** Check if adding an edge from -> to would create a cycle */
  private wouldCreateCycle(board: Board, from: string, to: string): boolean {
    // BFS from 'to' following dependsOn edges; if we reach 'from', it's a cycle
    const visited = new Set<string>();
    const queue = [to];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === from) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const card = board.cards.find(c => c.id === current);
      if (card?.dependsOn) {
        for (const dep of card.dependsOn) queue.push(dep);
      }
    }
    return false;
  }

  /**
   * Smart Execute: returns cards in dependency-aware execution order.
   * Uses topological sort — cards with no unmet dependencies come first.
   * Returns batches: each batch can run concurrently, batches must run sequentially.
   */
  getSmartExecutionOrder(boardId: string): BoardCard[][] {
    const board = this.boards.get(boardId);
    if (!board) return [];

    const pending = board.cards.filter(c => c.status === 'pending');
    if (pending.length === 0) return [];

    const pendingIds = new Set(pending.map(c => c.id));
    // Build in-degree map (only considering pending cards)
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>(); // card -> cards that depend on it

    for (const card of pending) {
      const deps = (card.dependsOn ?? []).filter(d => pendingIds.has(d));
      inDegree.set(card.id, deps.length);
      for (const dep of deps) {
        if (!dependents.has(dep)) dependents.set(dep, []);
        dependents.get(dep)!.push(card.id);
      }
    }

    const batches: BoardCard[][] = [];
    const remaining = new Set(pendingIds);

    while (remaining.size > 0) {
      // Find all cards with in-degree 0 (no unmet dependencies)
      const batch: BoardCard[] = [];
      for (const id of remaining) {
        if ((inDegree.get(id) ?? 0) === 0) {
          batch.push(pending.find(c => c.id === id)!);
        }
      }

      if (batch.length === 0) {
        // Circular dependency detected — just add remaining cards as-is
        for (const id of remaining) {
          batch.push(pending.find(c => c.id === id)!);
        }
        batches.push(batch.sort((a, b) => a.order - b.order));
        break;
      }

      // Sort batch by priority (high first) then order
      batch.sort((a, b) => {
        const prio = { high: 0, normal: 1, low: 2 };
        const pa = prio[a.priority] ?? 1;
        const pb = prio[b.priority] ?? 1;
        return pa !== pb ? pa - pb : a.order - b.order;
      });

      batches.push(batch);

      // Remove batch from graph, update in-degrees
      for (const card of batch) {
        remaining.delete(card.id);
        for (const dep of dependents.get(card.id) ?? []) {
          inDegree.set(dep, (inDegree.get(dep) ?? 1) - 1);
        }
      }
    }

    return batches;
  }

  /**
   * Get cards whose dependencies are now satisfied (all dependsOn cards completed).
   * Used for auto-cascading: when a card finishes, check which children are now unblocked.
   */
  getUnblockedCards(boardId: string): BoardCard[] {
    const board = this.boards.get(boardId);
    if (!board) return [];
    return board.cards.filter(card => {
      if (card.status !== 'pending') return false;
      if (!card.dependsOn || card.dependsOn.length === 0) return true;
      return card.dependsOn.every(depId => {
        const dep = board.cards.find(c => c.id === depId);
        return dep && (dep.status === 'completed');
      });
    });
  }

  // ── Bridge: sync card status from runtime TaskBoard ──

  syncCardFromRuntime(boardId: string, cardId: string, update: Partial<BoardCard>): void {
    const board = this.boards.get(boardId);
    if (!board) return;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return;
    Object.assign(card, update);
    // Don't call save() on every runtime update (too frequent), caller batches
  }

  saveBatch(): void {
    this.save();
  }

  private getFilePath(): string {
    return join(getMercuryHome(), 'memory', BOARDS_FILE);
  }
}
