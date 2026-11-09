import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EvalHarness } from '../runner.js';
import { call, textStep, toolStep } from '../fixture.js';
let harness: EvalHarness | undefined;
afterEach(async () => { await harness?.dispose(); });
it('keeps reviewRequired after an event tool completes but session persistence fails', async () => {
  harness = await EvalHarness.create({ name: 'event-handler-audit', channel: { type: 'web', style: 'plain' }, turns: [] }, { fakeTimers: false });
  const h = harness;
  const session = h.sessions.getOrCreateBound('web', 'event-handler-audit');
  const target = join(h.workDir, 'one-effect.txt');
  h.capabilities.permissions.getManifest().capabilities.filesystem.scopes = [{ path: h.workDir, read: true, write: true }];
  h.capabilities.permissions.onAsk(async () => 'yes');
  const append = h.sessions.appendMessage.bind(h.sessions);
  vi.spyOn(h.sessions, 'appendMessage').mockImplementation((id, message) => {
    if (message.role === 'assistant') throw new Error('Fixture session store disk full');
    return append(id, message);
  });
  h.player.load({ message: '', steps: [toolStep([call('create_file', { path: target, content: 'effect already happened' })]), textStep('Done.')] });
  h.agent.acceptEventTrigger({ trigger: { id: 'ci', enabled: true, secretEnv: 'TEST_EVENT_SECRET', task: 'Write a result.', allowTools: true, networkTools: [], destination: { channelType: 'web', sessionId: session.id } }, deliveryId: 'one', payload: '{}', payloadHash: '0'.repeat(64) });
  // Like the other real-Agent event evaluations, wait for the durable
  // outcome as well as idle; a busy runner may take more than one second.
  await vi.waitFor(() => {
    expect(h.agent.getEventTriggerDelivery('ci', 'one')?.status).toBe('paused');
    expect(h.agent.lifecycle.is('idle')).toBe(true);
  }, { timeout: 10_000, interval: 10 });
  expect(readFileSync(target, 'utf8')).toBe('effect already happened');
  expect(h.agent.getEventTriggerDelivery('ci', 'one')?.status).toBe('paused');
});
