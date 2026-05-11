import { Hono } from 'hono';
import type { SubAgentSupervisor } from '../../core/supervisor.js';
import type { BackgroundTaskManager } from '../../core/background-tasks.js';

const app = new Hono();

let supervisor: SubAgentSupervisor | undefined;
let backgroundTasks: BackgroundTaskManager | undefined;

export function setAgentSupervisor(s: SubAgentSupervisor): void {
  supervisor = s;
}

export function setBackgroundTaskManager(b: BackgroundTaskManager): void {
  backgroundTasks = b;
}

// List active sub-agents
app.get('/api/agents', (c: any) => {
  if (!supervisor) {
    return c.json({ agents: [], available: false });
  }
  const agents = supervisor.getActiveAgents().map((a: any) => ({
    id: a.id,
    task: a.task,
    status: a.status,
    progress: a.progress || null,
    startedAt: a.startedAt,
  }));
  return c.json({ agents, available: true });
});

// Halt all sub-agents
app.post('/api/agents/halt', (c: any) => {
  if (!supervisor) {
    return c.json({ error: 'Sub-agents not available' }, 400);
  }
  supervisor.haltAll();
  return c.json({ ok: true, message: 'All sub-agents halted' });
});

// Stop all and clear task board
app.post('/api/agents/stop', (c: any) => {
  if (!supervisor) {
    return c.json({ error: 'Sub-agents not available' }, 400);
  }
  supervisor.haltAll();
  supervisor.clearTaskBoard();
  return c.json({ ok: true, message: 'All agents stopped, task board cleared' });
});

// List background tasks
app.get('/api/bg', (c: any) => {
  if (!backgroundTasks) {
    return c.json({ tasks: [], available: false });
  }
  const tasks = backgroundTasks.getAllSummaries();
  return c.json({ tasks, available: true });
});

// Get specific background task
app.get('/api/bg/:id', (c: any) => {
  if (!backgroundTasks) {
    return c.json({ error: 'Background tasks not available' }, 400);
  }
  const id = c.req.param('id');
  const task = backgroundTasks.get(id);
  if (!task) {
    return c.json({ error: 'Task not found' }, 404);
  }
  const output = (task.stdout + '\n' + task.stderr).trim();
  return c.json({
    id: task.id,
    command: task.command,
    task: task.task,
    status: task.status,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    exitCode: task.exitCode,
    output: output.slice(-5000),
  });
});

// Cancel a background task
app.post('/api/bg/:id/cancel', (c: any) => {
  if (!backgroundTasks) {
    return c.json({ error: 'Background tasks not available' }, 400);
  }
  const id = c.req.param('id');
  const cancelled = backgroundTasks.cancel(id);
  if (!cancelled) {
    return c.json({ error: 'Task not found or not running' }, 404);
  }
  return c.json({ ok: true, message: `Task ${id} cancelled` });
});

// Clear completed background tasks
app.post('/api/bg/clear', (c: any) => {
  if (!backgroundTasks) {
    return c.json({ error: 'Background tasks not available' }, 400);
  }
  const cleared = backgroundTasks.clearCompleted();
  return c.json({ ok: true, cleared });
});

export default app;
