import { resolve, dirname } from 'node:path';
import { logger } from '../utils/logger.js';
import type { FileLock } from '../types/agent.js';

export class FileLockManager {
  private locks: Map<string, FileLock[]> = new Map();

  acquire(filePath: string, agentId: string, mode: 'read' | 'write'): boolean {
    const normalizedPath = resolve(filePath);
    const existing = this.locks.get(normalizedPath) || [];

    if (mode === 'read') {
      const writeLock = existing.find(l => l.mode === 'write');
      if (writeLock && writeLock.agentId !== agentId) {
        logger.debug({ path: normalizedPath, lockedBy: writeLock.agentId }, 'File locked for writing, cannot acquire read lock');
        return false;
      }
      const existingLock = existing.find(l => l.agentId === agentId && l.mode === 'read');
      if (existingLock) return true;
      const lock: FileLock = {
        filePath: normalizedPath,
        agentId,
        mode: 'read',
        acquiredAt: Date.now(),
      };
      existing.push(lock);
      this.locks.set(normalizedPath, existing);
      logger.debug({ path: normalizedPath, agentId, mode: 'read' }, 'Read lock acquired');
      return true;
    }

    if (mode === 'write') {
      const conflictingLock = existing.find(l => l.agentId !== agentId);
      if (conflictingLock) {
        logger.debug({ path: normalizedPath, lockedBy: conflictingLock.agentId, lockMode: conflictingLock.mode }, 'File locked, cannot acquire write lock');
        return false;
      }
      const existingWriteLock = existing.find(l => l.agentId === agentId && l.mode === 'write');
      if (existingWriteLock) return true;

      this.releaseAllFor(agentId, normalizedPath);

      const lock: FileLock = {
        filePath: normalizedPath,
        agentId,
        mode: 'write',
        acquiredAt: Date.now(),
      };
      this.locks.set(normalizedPath, [lock]);
      logger.debug({ path: normalizedPath, agentId, mode: 'write' }, 'Write lock acquired');
      return true;
    }

    return false;
  }

  release(filePath: string, agentId: string): void {
    const normalizedPath = resolve(filePath);
    const existing = this.locks.get(normalizedPath);
    if (!existing) return;

    const updated = existing.filter(l => !(l.agentId === agentId));
    if (updated.length === 0) {
      this.locks.delete(normalizedPath);
    } else {
      this.locks.set(normalizedPath, updated);
    }
    logger.debug({ path: normalizedPath, agentId }, 'Lock released');
  }

  private releaseAllFor(agentId: string, normalizedPath: string): void {
    const existing = this.locks.get(normalizedPath);
    if (!existing) return;

    const updated = existing.filter(l => l.agentId !== agentId);
    if (updated.length === 0) {
      this.locks.delete(normalizedPath);
    } else {
      this.locks.set(normalizedPath, updated);
    }
  }

  releaseAll(agentId: string): void {
    for (const [normalizedPath, locks] of this.locks.entries()) {
      const updated = locks.filter(l => l.agentId !== agentId);
      if (updated.length === 0) {
        this.locks.delete(normalizedPath);
      } else {
        this.locks.set(normalizedPath, updated);
      }
    }
    logger.debug({ agentId }, 'All locks released for agent');
  }

  isLocked(filePath: string): boolean {
    const normalizedPath = resolve(filePath);
    return (this.locks.get(normalizedPath)?.length ?? 0) > 0;
  }

  isWriteLockedByOther(filePath: string, agentId: string): boolean {
    const normalizedPath = resolve(filePath);
    const existing = this.locks.get(normalizedPath) || [];
    return existing.some(l => l.mode === 'write' && l.agentId !== agentId);
  }

  getLocksFor(agentId: string): FileLock[] {
    const result: FileLock[] = [];
    for (const locks of this.locks.values()) {
      for (const lock of locks) {
        if (lock.agentId === agentId) {
          result.push(lock);
        }
      }
    }
    return result;
  }

  getAllLocks(): FileLock[] {
    const result: FileLock[] = [];
    for (const locks of this.locks.values()) {
      result.push(...locks);
    }
    return result;
  }

  clearAll(): void {
    this.locks.clear();
    logger.info('All file locks cleared');
  }

  detectDeadlock(): string[] | null {
    const allLocks = this.getAllLocks();
    const writeLocks = allLocks.filter(l => l.mode === 'write');
    if (writeLocks.length < 2) return null;

    const agentLocks = new Map<string, Set<string>>();
    for (const lock of allLocks) {
      if (!agentLocks.has(lock.agentId)) {
        agentLocks.set(lock.agentId, new Set());
      }
      agentLocks.get(lock.agentId)!.add(lock.filePath);
    }

    const agentIds = [...agentLocks.keys()];
    for (let i = 0; i < agentIds.length; i++) {
      for (let j = i + 1; j < agentIds.length; j++) {
        const a = agentIds[i];
        const b = agentIds[j];
        const locksA = agentLocks.get(a)!;
        const locksB = agentLocks.get(b)!;

        const aWantsBHas = [...locksB].some(p => this.isWriteLockedByOther(p, a));
        const bWantsAHas = [...locksA].some(p => this.isWriteLockedByOther(p, b));

        if (aWantsBHas && bWantsAHas) {
          return [a, b];
        }
      }
    }

    return null;
  }
}