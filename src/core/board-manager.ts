import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { Board, BoardCard, BoardContext, BoardContextEvent, CardActivityEntry, BoardStatus, SubAgentStatus, SubAgentPriority, CardComment, CardAttachment, CardLabel } from '../types/agent.js';

const BOARDS_FILE = 'boards.json';

export class BoardManager {
  private boards: Map<string, Board> = new Map();
  private counter: number = 0;
  private cardCounter: number = 0;
  private onChangeListeners: Array<(boardId: string) => void> = [];
  private dirtyBoards: Set<string> = new Set();

  /** Register a listener called after any board mutation (with the affected board ID) */
  onBoardChange(listener: (boardId: string) => void): void {
    this.onChangeListeners.push(listener);
  }

  private notifyChange(boardId: string): void {
    for (const fn of this.onChangeListeners) {
      try { fn(boardId); } catch {}
    }
  }

  /** Mark a board as dirty for next save notification */
  private markDirty(boardId: string): void {
    this.dirtyBoards.add(boardId);
  }

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

  save(changedBoardId?: string): void {
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
    // Notify listeners for dirty boards
    if (changedBoardId) this.dirtyBoards.add(changedBoardId);
    for (const bid of this.dirtyBoards) {
      this.notifyChange(bid);
    }
    this.dirtyBoards.clear();
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
    this.save(id);
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
    this.save(id);
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
    this.save(id);
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
    this.save(id);
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
    this.save(id);
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
    this.save(boardId);
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
    this.save(boardId);
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
    this.save(boardId);
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
    this.save(boardId);
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
    this.save(boardId);
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
      this.save(boardId);
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
    this.save(boardId);
    return comment;
  }

  deleteComment(boardId: string, cardId: string, commentId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.comments) return false;
    const idx = card.comments.findIndex(c => c.id === commentId);
    if (idx === -1) return false;
    card.comments.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save(boardId);
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
    this.save(boardId);
    return full;
  }

  deleteAttachment(boardId: string, cardId: string, attachmentId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.attachments) return false;
    const idx = card.attachments.findIndex(a => a.id === attachmentId);
    if (idx === -1) return false;
    card.attachments.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save(boardId);
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
    this.save(boardId);
    return label;
  }

  removeLabel(boardId: string, cardId: string, labelId: string): boolean {
    const card = this.getCard(boardId, cardId);
    if (!card || !card.labels) return false;
    const idx = card.labels.findIndex(l => l.id === labelId);
    if (idx === -1) return false;
    card.labels.splice(idx, 1);
    this.boards.get(boardId)!.updatedAt = Date.now();
    this.save(boardId);
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
    this.save(boardId);
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
    this.save(boardId);
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
    this.save(boardId);
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

  /** Push an activity log entry to a card (real-time step history) */
  pushActivity(boardId: string, cardId: string, entry: Omit<CardActivityEntry, 'timestamp'>): void {
    const board = this.boards.get(boardId);
    if (!board) return;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return;
    if (!card.activityLog) card.activityLog = [];
    card.activityLog.push({ ...entry, timestamp: Date.now() });
    // Cap at 50 entries per card
    if (card.activityLog.length > 50) {
      card.activityLog = card.activityLog.slice(-50);
    }
  }

  saveBatch(boardId?: string): void {
    this.save(boardId);
  }

  // ── Board Context Management ──

  /** Get or initialize the board context */
  getBoardContext(boardId: string): BoardContext | undefined {
    const board = this.boards.get(boardId);
    if (!board) return undefined;
    if (!board.context) {
      board.context = { variables: {}, events: [], maxEvents: 200 };
    }
    return board.context;
  }

  /** Add an event to the board context log */
  addContextEvent(boardId: string, event: Omit<BoardContextEvent, 'timestamp'>): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    const full: BoardContextEvent = { ...event, timestamp: Date.now() };
    ctx.events.push(full);
    // Rolling window
    const max = ctx.maxEvents ?? 50;
    if (ctx.events.length > max) {
      ctx.events = ctx.events.slice(-max);
    }
    // Don't save here — caller is responsible for batching saves
  }

  /** Set a shared context variable */
  setContextVariable(boardId: string, key: string, value: any): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    ctx.variables[key] = value;
    this.save(boardId);
  }

  /** Set project instructions for the board (system prompt for all agents) */
  setProjectInstructions(boardId: string, instructions: string): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    ctx.projectInstructions = instructions;
    this.save(boardId);
  }

  /** Set project structure map */
  setProjectStructure(boardId: string, structure: Record<string, string>): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    ctx.projectStructure = structure;
    this.save(boardId);
  }

  /** Add to accumulated knowledge base */
  addKnowledge(boardId: string, knowledge: string): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    if (!ctx.knowledgeBase) ctx.knowledgeBase = [];
    // Avoid duplicates
    if (!ctx.knowledgeBase.includes(knowledge)) {
      ctx.knowledgeBase.push(knowledge);
      // Cap at 50 entries
      if (ctx.knowledgeBase.length > 50) ctx.knowledgeBase = ctx.knowledgeBase.slice(-50);
      this.save(boardId);
    }
  }

  /** Set the board's shared working directory */
  setBoardWorkingDirectory(boardId: string, dir: string): void {
    const ctx = this.getBoardContext(boardId);
    if (!ctx) return;
    ctx.workingDirectory = dir;
    this.addContextEvent(boardId, {
      cardId: 'system',
      type: 'directory-changed',
      summary: `Working directory set to: ${dir}`,
      data: { directory: dir },
    });
  }

  /**
   * Build context prompt for a card's sub-agent.
   * 
   * DESIGN: Minimal, relevant context only. The task is king.
   * We budget ~1200 chars max to avoid drowning the task prompt.
   * 
   * What causes agents to "bluff" or go off-task:
   * - Too much irrelevant context (all cards, all events, all knowledge)
   * - Context longer than the actual task
   * - Redundant "guidance" instructions that confuse the system prompt
   * 
   * What we inject (in priority order, with hard limits):
   * 1. Working directory (one line)
   * 2. Project instructions (user-authored, capped at 400 chars)
   * 3. Direct dependency results only (capped at 200 chars each)
   * 4. Shared variables (only if compact)
   */
  buildCardContext(boardId: string, cardId: string): string {
    const board = this.boards.get(boardId);
    if (!board) return '';
    const ctx = board.context;
    const card = board.cards.find(c => c.id === cardId);
    if (!card) return '';

    const parts: string[] = [];

    // 1. Working directory (essential for file operations)
    if (ctx?.workingDirectory) {
      parts.push(`cwd: ${ctx.workingDirectory}`);
    }

    // 2. Project instructions — user-authored, always relevant, hard cap
    if (ctx?.projectInstructions) {
      const instr = ctx.projectInstructions.length > 400
        ? ctx.projectInstructions.slice(0, 400) + '...'
        : ctx.projectInstructions;
      parts.push(`Rules: ${instr}`);
    }

    // 3. Direct dependency results ONLY (not all cards — just what this card needs)
    if (card.dependsOn && card.dependsOn.length > 0) {
      const depResults: string[] = [];
      for (const depId of card.dependsOn) {
        const dep = board.cards.find(c => c.id === depId);
        if (dep && dep.status === 'completed' && dep.result) {
          depResults.push(`"${dep.task}": ${dep.result.slice(0, 200)}`);
        }
      }
      if (depResults.length > 0) {
        parts.push(`Prior results:\n${depResults.join('\n')}`);
      }
    }

    // 4. Shared variables — only if compact
    if (ctx?.variables) {
      const keys = Object.keys(ctx.variables);
      if (keys.length > 0 && keys.length <= 8) {
        const varStr = JSON.stringify(ctx.variables);
        if (varStr.length < 250) {
          parts.push(`Vars: ${varStr}`);
        }
      }
    }

    if (parts.length === 0) return '';

    return `\n[Context] ${parts.join(' | ')}\n`;
  }

  private getFilePath(): string {
    return join(getMercuryHome(), 'memory', BOARDS_FILE);
  }
}
