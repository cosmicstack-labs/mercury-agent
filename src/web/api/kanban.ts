import { Hono } from 'hono';
import type { SubAgentSupervisor } from '../../core/supervisor.js';

const app = new Hono();

let supervisor: SubAgentSupervisor | undefined;

export function setKanbanSupervisor(s: SubAgentSupervisor): void {
  supervisor = s;
}

// Get full task board
app.get('/api/kanban', (c: any) => {
  if (!supervisor) {
    return c.json({ entries: [], available: false });
  }
  const board = supervisor.getTaskBoard();
  const entries = board.getAll().map((e: any) => ({
    ...e,
    tokenUsage: e.tokenUsage || null,
  }));
  const resources = supervisor.getResourceUsage();
  return c.json({ entries, resources, available: true });
});

// Get entries by status
app.get('/api/kanban/status/:status', (c: any) => {
  if (!supervisor) return c.json({ entries: [] });
  const status = c.req.param('status');
  const board = supervisor.getTaskBoard();
  const entries = board.getByStatus(status);
  return c.json({ entries });
});

// Get single entry
app.get('/api/kanban/:id', (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const board = supervisor.getTaskBoard();
  const entry = board.get(c.req.param('id'));
  if (!entry) return c.json({ error: 'Not found' }, 404);
  return c.json({ entry });
});

// Spawn a new agent task
app.post('/api/kanban/spawn', async (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const body = await c.req.json();
  const { task, priority, workingDirectory, maxSteps, sourceChannelType, sourceChannelId } = body;
  if (!task || typeof task !== 'string' || task.trim().length === 0) {
    return c.json({ error: 'Task description required' }, 400);
  }
  const id = await supervisor.spawn({
    task: task.trim(),
    priority: priority || 'normal',
    workingDirectory: workingDirectory || undefined,
    maxSteps: maxSteps || undefined,
    sourceChannelType: sourceChannelType || 'web',
    sourceChannelId: sourceChannelId || 'kanban',
  });
  return c.json({ ok: true, id });
});

// Halt a specific agent
app.post('/api/kanban/:id/halt', async (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const id = c.req.param('id');
  const halted = await supervisor.halt(id);
  return c.json({ ok: halted });
});

// Pause a specific agent
app.post('/api/kanban/:id/pause', async (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const id = c.req.param('id');
  const paused = await supervisor.pause(id);
  return c.json({ ok: paused });
});

// Resume a specific agent
app.post('/api/kanban/:id/resume', async (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const id = c.req.param('id');
  const resumed = await supervisor.resume(id);
  return c.json({ ok: resumed });
});

// Halt all agents
app.post('/api/kanban/halt-all', async (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  await supervisor.haltAll();
  return c.json({ ok: true });
});

// Clear completed/failed/halted entries from board
app.post('/api/kanban/clear-done', (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  const board = supervisor.getTaskBoard();
  const all = board.getAll();
  let cleared = 0;
  for (const entry of all) {
    if (entry.status === 'completed' || entry.status === 'failed' || entry.status === 'halted') {
      board.remove(entry.agentId);
      cleared++;
    }
  }
  return c.json({ ok: true, cleared });
});

// Clear entire board
app.post('/api/kanban/clear', (c: any) => {
  if (!supervisor) return c.json({ error: 'Not available' }, 400);
  supervisor.haltAll();
  supervisor.clearTaskBoard();
  return c.json({ ok: true });
});

export default app;
