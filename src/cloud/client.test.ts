import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }));
vi.mock('./pairing.js', () => ({ refreshToken: refreshTokenMock }));

import { MercuryCloudClient } from './client.js';

afterEach(() => {
  vi.restoreAllMocks();
  refreshTokenMock.mockReset();
});

describe('MercuryCloudClient', () => {
  it('waits for open and observes rejected async message handlers', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Expected TCP WebSocket address');

    const handlerError = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const client = new MercuryCloudClient(`ws://127.0.0.1:${address.port}`, 'token', 'agent', 'refresh', 'https://api.example.com');
    client.on('agent.status', async () => {
      throw new Error('handler exploded');
    });
    server.on('connection', (socket) => {
      socket.send(JSON.stringify({ type: 'agent.status' }));
    });

    await client.connect();
    expect(client.isConnected()).toBe(true);
    await vi.waitFor(() => expect(handlerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: 'handler exploded', type: 'agent.status' }),
      'Mercury Cloud WebSocket handler failed',
    ));

    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('never throws from send and applies the buffered amount guard', () => {
    const client = new MercuryCloudClient('ws://example.test', 'token', 'agent', 'refresh', 'https://api.example.com');
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: vi.fn(() => { throw new Error('socket failed'); }),
    };
    (client as any).ws = socket;

    expect(client.send({ type: 'agent.status' })).toBe(false);
    socket.bufferedAmount = 1024 * 1024 + 1;
    expect(client.send({ type: 'agent.status' })).toBe(false);
    expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it('sends a command ACK with the durable request ID', () => {
    const client = new MercuryCloudClient('ws://example.test', 'token', 'agent', 'refresh', 'https://api.example.com');
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: vi.fn() };
    (client as any).ws = socket;

    expect(client.sendCommandAck('request-1')).toBe(true);
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      type: 'agent.command.ack',
      agentId: 'agent',
      payload: { requestId: 'request-1' },
    });
  });

  it('does not reconnect after disconnect while refresh is in flight', async () => {
    let resolveRefresh!: (value: { jwt: string; refreshToken: string }) => void;
    refreshTokenMock.mockReturnValue(new Promise((resolve) => { resolveRefresh = resolve; }));
    const client = new MercuryCloudClient('ws://example.test', 'token', 'agent', 'refresh', 'https://api.example.com');
    const connect = vi.spyOn(client, 'connect');

    const refreshing = (client as any).tryRefreshAndReconnect();
    client.disconnect();
    resolveRefresh({ jwt: 'new-token', refreshToken: 'new-refresh' });
    await refreshing;

    expect(connect).not.toHaveBeenCalled();
  });

  it('schedules another attempt after a transient auth refresh failure', async () => {
    refreshTokenMock.mockRejectedValue(new Error('temporarily unavailable'));
    const client = new MercuryCloudClient('ws://example.test', 'token', 'agent', 'refresh', 'https://api.example.com');
    (client as any).authRefreshNeeded = true;

    await (client as any).tryRefreshAndReconnect();

    expect((client as any).reconnectTimer).not.toBeNull();
    client.disconnect();
  });

  it('keeps only one reconnect timer', () => {
    vi.useFakeTimers();
    const client = new MercuryCloudClient('ws://example.test', 'token', 'agent', 'refresh', 'https://api.example.com');
    (client as any).scheduleReconnect();
    const timer = (client as any).reconnectTimer;
    (client as any).scheduleReconnect();
    expect((client as any).reconnectTimer).toBe(timer);
    client.disconnect();
    vi.useRealTimers();
  });
});
