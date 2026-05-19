import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { getMercuryHome } from '../../utils/config.js';

export interface ChatMessage {
  id: string;
  threadId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

const CHAT_DIR = 'web-chat-history';

function getChatDir(): string {
  const dir = join(getMercuryHome(), CHAT_DIR);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getThreadPath(threadId: string): string {
  const safeId = threadId.replace(/[^a-zA-Z0-9_:-]/g, '_');
  return join(getChatDir(), `${safeId}.json`);
}

export function saveThread(thread: ChatThread): void {
  try {
    writeFileSync(getThreadPath(thread.id), JSON.stringify(thread, null, 2), 'utf-8');
  } catch {}
}

export function loadThread(threadId: string): ChatThread | null {
  const path = getThreadPath(threadId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as ChatThread;
  } catch {
    return null;
  }
}

export function listThreads(): ChatThread[] {
  const dir = getChatDir();
  if (!existsSync(dir)) return [];
  try {
    const files: string[] = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
    const threads: ChatThread[] = [];
    for (const file of files) {
      try {
        const raw = readFileSync(join(dir, file), 'utf-8');
        const thread = JSON.parse(raw) as ChatThread;
        threads.push({ ...thread, messages: [] }); // list without messages for perf
      } catch {}
    }
    return threads.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function deleteThread(threadId: string): boolean {
  const path = getThreadPath(threadId);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export function appendMessage(threadId: string, msg: ChatMessage): void {
  let thread = loadThread(threadId);
  if (!thread) {
    thread = {
      id: threadId,
      title: msg.content.slice(0, 40) || 'New Thread',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
  }
  thread.messages.push(msg);
  thread.updatedAt = msg.timestamp;
  // Update title from first user message
  if (thread.messages.length === 1 && msg.role === 'user') {
    thread.title = msg.content.slice(0, 50) + (msg.content.length > 50 ? '...' : '');
  }
  saveThread(thread);
}
