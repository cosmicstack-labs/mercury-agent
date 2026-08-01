import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { logger } from '../utils/logger.js';

const { refreshTokenMock } = vi.hoisted(() => ({ refreshTokenMock: vi.fn() }));
vi.mock('./pairing.js', () => ({ refreshToken: refreshTokenMock }));

import { MercuryCloudClient } from './client.js';
import type { CloudTokenStore } from './token-store.js';

function makeStore(jwt = 'token', refreshTokenValue = 'refresh', agentId = 'agent'): CloudTokenStore {
  return {
    getJwt: vi.fn(() => jwt),
    getRefreshToken: vi.fn(() => refreshTokenValue),
    getAgentId: vi.fn(() => agentId),
    getApiUrl: vi.fn(() => 'https://api.example.com'),
    getAgentApiKey: vi.fn(() => 'mcapk_testkey'),
    getTokens: vi.fn(() => ({ jwt, refreshToken: refreshTokenValue })),
    isJwtNearExpiry: vi.fn(() => false),
    setTokens: vi.fn(),
    setTokensAndPersist: vi.fn(),
    rotate: vi.fn(async () => {
      const result = { jwt: 'new-token', refreshToken: 'new-refresh' };
      jwt = result.jwt;
      refreshTokenValue = result.refreshToken;
      return result;
    }),
    rotateIfExpired: vi.fn(async () => jwt),
    addListener: vi.fn(() => () => {}),
  } as unknown as CloudTokenStore;
}

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
    const client = new MercuryCloudClient(`ws://127.0.0.1:${address.port}`, makeStore());
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

  it('refreshes an expired access token before the WebSocket handshake', async () => {
    const server = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (typeof address === 'string' || address === null) throw new Error('Expected TCP WebSocket address');
    const store = makeStore('expired-token');
    (store.rotateIfExpired as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      (store.getJwt as ReturnType<typeof vi.fn>).mockReturnValue('fresh-token');
      return 'fresh-token';
    });
    const authorization = new Promise<string | undefined>((resolve) => {
      server.once('connection', (_socket, request) => resolve(request.headers.authorization));
    });
    const client = new MercuryCloudClient(`ws://127.0.0.1:${address.port}`, store);

    await client.connect();

    await expect(authorization).resolves.toBe('Bearer fresh-token');
    expect(store.rotateIfExpired).toHaveBeenCalledWith(2 * 60_000);
    client.disconnect();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('does not open a socket after disconnect during startup token preparation', async () => {
    let finishPreparation!: () => void;
    const store = makeStore();
    (store.rotateIfExpired as ReturnType<typeof vi.fn>).mockReturnValue(new Promise<string>((resolve) => {
      finishPreparation = () => resolve('fresh-token');
    }));
    const client = new MercuryCloudClient('ws://127.0.0.1:1', store);

    const connecting = client.connect();
    client.disconnect();
    finishPreparation();
    await connecting;

    expect(client.isConnected()).toBe(false);
    expect((client as any).ws).toBeNull();
  });

  it('never throws from send and applies the buffered amount guard', () => {
    const client = new MercuryCloudClient('ws://example.test', makeStore());
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
    const client = new MercuryCloudClient('ws://example.test', makeStore('token', 'refresh', 'agent'));
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
    const store = makeStore();
    const client = new MercuryCloudClient('ws://example.test', store);
    const connect = vi.spyOn(client, 'connect');

    const refreshing = (client as any).tryRefreshAndReconnect();
    client.disconnect();
    resolveRefresh({ jwt: 'new-token', refreshToken: 'new-refresh' });
    await refreshing;

    expect(connect).not.toHaveBeenCalled();
  });

  it('schedules another attempt after a transient auth refresh failure', async () => {
    refreshTokenMock.mockRejectedValue(new Error('temporarily unavailable'));
    const client = new MercuryCloudClient('ws://example.test', makeStore());
    (client as any).authRefreshNeeded = true;

    await (client as any).tryRefreshAndReconnect();

    expect((client as any).reconnectTimer).not.toBeNull();
    client.disconnect();
  });

  it('keeps only one reconnect timer', () => {
    vi.useFakeTimers();
    const client = new MercuryCloudClient('ws://example.test', makeStore());
    (client as any).scheduleReconnect();
    const timer = (client as any).reconnectTimer;
    (client as any).scheduleReconnect();
    expect((client as any).reconnectTimer).toBe(timer);
    client.disconnect();
    vi.useRealTimers();
  });
});
