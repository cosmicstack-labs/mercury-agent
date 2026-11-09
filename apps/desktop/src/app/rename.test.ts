import { beforeEach, describe, expect, it, vi } from 'vitest';

const renameCall = vi.fn();
vi.mock('~/api/mercury', () => ({ chat: { renameThread: (id: string, title: string) => renameCall(id, title) } }));
const { renameThread } = await import('./events');
const { useChat } = await import('./store');
const thread = (id: string, title: string) => ({ id, title, createdAt: '2026-11-06T10:00:00Z', messages: [] });

describe('rename a chat', () => {
  beforeEach(() => { renameCall.mockReset(); useChat.setState({ threads: [thread('one', 'Original'), thread('two', 'Other')] }); });
  it('updates the canonical title in place after the server confirms persistence', async () => {
    renameCall.mockResolvedValue({ id: 'one', title: 'New name 😀' });
    await renameThread('one', '  New name 😀  ');
    expect(renameCall).toHaveBeenCalledWith('one', '  New name 😀  ');
    expect(useChat.getState().threads.map(t => t.title)).toEqual(['New name 😀', 'Other']);
  });
  it('retains the existing title and surfaces failures for the dialog', async () => {
    renameCall.mockRejectedValue(new Error('Could not save'));
    await expect(renameThread('one', 'Changed')).rejects.toThrow('Could not save');
    expect(useChat.getState().threads[0].title).toBe('Original');
  });
});
