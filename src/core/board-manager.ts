import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { Board, BoardCard, BoardStatus, SubAgentStatus, SubAgentPriority } from '../types/agent.js';

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
