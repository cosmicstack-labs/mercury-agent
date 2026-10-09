import { describe, expect, it } from 'vitest';
import { CLIChannel } from './cli.js';

/**
 * The permission resolver used to be ONE slot: a second concurrent prompt
 * (sub-agent, bot, a choice during a permission ask) overwrote it and the
 * first promise never settled. Now every prompt has its own resolver keyed
 * by id and the TUI shows them in order.
 */
describe('CLIChannel prompt resolver map', () => {
  it('shows prompts in arrival order and settles each promise with its own answer', async () => {
    const channel = new CLIChannel();
    const first = channel.askPermission('write a.txt?');
    const second = channel.presentChoicePrompt('pick one', [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }]);
    const third = channel.askToContinue('keep going?');

    expect(channel.getTuiState().permissionPrompt?.message).toBe('write a.txt?');
    expect(channel.pendingPromptIds()).toHaveLength(3);

    // Answer what is on screen → the next queued prompt appears.
    channel.getTuiState().permissionPrompt!.resolve('always');
    await expect(first).resolves.toBe('always');
    expect(channel.getTuiState().permissionPrompt?.message).toBe('pick one');

    channel.getTuiState().permissionPrompt!.resolve('y');
    await expect(second).resolves.toBe('y');
    expect(channel.getTuiState().permissionPrompt?.type).toBe('continue');

    channel.getTuiState().permissionPrompt!.resolve('yes');
    await expect(third).resolves.toBe(true);
    expect(channel.getTuiState().permissionPrompt).toBeNull();
    expect(channel.pendingPromptIds()).toHaveLength(0);
  });

  it('a queued prompt can be settled by id before it is shown, without disturbing the visible one', async () => {
    const channel = new CLIChannel();
    const shown = channel.prompt('name?');
    const queued = channel.presentChoicePrompt('later', [{ value: 'a', label: 'A' }]);
    const [shownId, queuedId] = channel.pendingPromptIds();

    expect(channel.resolvePrompt(queuedId, 'a')).toBe(true);
    await expect(queued).resolves.toBe('a');
    expect(channel.getTuiState().permissionPrompt?.id).toBe(shownId);
    expect(channel.pendingPromptIds()).toEqual([shownId]);

    expect(channel.resolvePrompt(queuedId, 'again')).toBe(false); // already settled
    expect(channel.resolvePrompt(shownId, 'mercury')).toBe(true);
    await expect(shown).resolves.toBe('mercury');
    expect(channel.getTuiState().permissionPrompt).toBeNull();
  });

  it('a timed-out choice resolves the OLDEST unanswered choice prompt, not whatever is on screen', async () => {
    const channel = new CLIChannel();
    const ask = channel.askPermission('run ls?');
    const choice = channel.presentChoicePrompt('which?', [{ value: '0', label: 'zero' }, { value: '1', label: 'one' }]);

    channel.resolveChoicePromptWithDefault('1');
    await expect(choice).resolves.toBe('1');
    // The permission ask is still on screen and still pending.
    expect(channel.getTuiState().permissionPrompt?.message).toBe('run ls?');
    channel.getTuiState().permissionPrompt!.resolve('no');
    await expect(ask).resolves.toBe('no');
  });

  it('clearPermissionPrompt settles every pending prompt with its declined answer', async () => {
    const channel = new CLIChannel();
    const ask = channel.askPermission('x?');
    const cont = channel.askToContinue('y?');
    const choice = channel.presentChoicePrompt('z?', [{ value: 'a', label: 'A' }]);
    channel.clearPermissionPrompt();
    await expect(ask).resolves.toBe('no');
    await expect(cont).resolves.toBe(false);
    await expect(choice).resolves.toBe('');
    expect(channel.getTuiState().permissionPrompt).toBeNull();
    expect(channel.pendingPromptIds()).toEqual([]);
  });
});
