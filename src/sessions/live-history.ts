import type { SessionRepository } from './repository.js';
import type { Session, SessionBinding, SessionMessage } from './types.js';

export interface ConversationHistoryRequest {
  requestId: string;
  sessionId?: string;
  cursor?: string;
  limit?: number;
}

function serializeBinding(binding: SessionBinding) {
  return {
    ...binding,
    createdAt: new Date(binding.createdAt).toISOString(),
    updatedAt: new Date(binding.updatedAt).toISOString(),
  };
}

function serializeMessage(message: SessionMessage) {
  return {
    ...message,
    reasoning: typeof message.reasoning === 'string'
      ? message.reasoning
      : message.reasoning == null
        ? undefined
        : JSON.stringify(message.reasoning),
    timestamp: new Date(message.timestamp).toISOString(),
  };
}

function serializeSession(session: Session, agentId: string) {
  const { messages: _, ...summary } = session;
  return {
    ...summary,
    agentId,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
    bindings: session.bindings.map(serializeBinding),
  };
}

function encodeCursor(session: Session): string {
  return Buffer.from(JSON.stringify([session.updatedAt, session.id])).toString('base64url');
}

function decodeCursor(cursor: string): [number, string] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isFinite(parsed[0]) || typeof parsed[1] !== 'string') throw new Error();
    return [parsed[0] as number, parsed[1]];
  } catch {
    throw new Error('Invalid conversation history cursor');
  }
}

export function buildConversationHistoryPayload(repository: SessionRepository, request: ConversationHistoryRequest, agentId: string) {
  if (request.sessionId) {
    const session = repository.get(request.sessionId);
    if (session.status === 'deleted') throw new Error(`Session not found: ${request.sessionId}`);
    const messages = [...session.messages]
      .sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp || a.id.localeCompare(b.id))
      .map(serializeMessage);
    return { requestId: request.requestId, session: serializeSession(session, agentId), messages };
  }

  const requestedLimit = Number.isFinite(request.limit) ? Math.trunc(request.limit!) : 20;
  const limit = Math.max(1, Math.min(50, requestedLimit));
  let active = repository.list().sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  if (request.cursor) {
    const [updatedAt, id] = decodeCursor(request.cursor);
    active = active.filter((session) => session.updatedAt < updatedAt || (session.updatedAt === updatedAt && session.id > id));
  }
  const page = active.slice(0, limit);
  const sessions = page.map((session) => ({
    id: session.id,
    agentId,
    alias: session.alias,
    title: session.title,
    titleSource: session.titleSource,
    status: session.status,
    revision: session.revision,
    createdAt: new Date(session.createdAt).toISOString(),
    updatedAt: new Date(session.updatedAt).toISOString(),
  }));
  return {
    requestId: request.requestId,
    sessions,
    nextCursor: active.length > limit ? encodeCursor(page[page.length - 1]) : null,
  };
}
