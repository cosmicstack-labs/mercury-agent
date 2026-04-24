import { Hono } from 'hono';

export interface AgentStatus {
  running: boolean;
  pid: number | null;
  state: string;
  uptime: string;
  defaultProvider: string;
  providers: Array<{ name: string; enabled: boolean; hasKey: boolean }>;
  tokensUsed: number;
  tokenBudget: number;
  memoryTotal: number;
  memoryByType: Record<string, number>;
}

let currentStatus: AgentStatus = {
  running: false,
  pid: null,
  state: 'unknown',
  uptime: '—',
  defaultProvider: '—',
  providers: [],
  tokensUsed: 0,
  tokenBudget: 1000000,
  memoryTotal: 0,
  memoryByType: {},
};

export function updateStatus(status: Partial<AgentStatus>): void {
  currentStatus = { ...currentStatus, ...status };
}

export function getStatus(): AgentStatus {
  return { ...currentStatus };
}

const status = new Hono();

status.get('/api/status', (c) => {
  return c.json(getStatus());
});

export default status;