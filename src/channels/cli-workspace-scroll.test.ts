import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIChannel } from './cli.js';

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function channelWithWorkspace(): CLIChannel {
  const channel = new CLIChannel();
  (channel as any).state.workspace = {
    active: true,
    rootPath: '/project',
    nodes: [],
    selectedIndex: 0,
    selectedPath: null,
    openedFilePath: '/project/file.ts',
    openedFilePreview: Array.from({ length: 100 }, (_, index) => `line ${index + 1}`),
    gitFiles: [],
    stagedCount: 0,
    unstagedCount: 0,
    branch: 'main',
    ahead: 0,
    behind: 0,
    lastAction: '',
    codeScrollOffset: 0,
    focusArea: 'code',
    chatCollapsed: false,
    chatScrollOffset: 0,
    rightPanel: 'chat',
  };
  return channel;
}

describe('CLI workspace scrolling', () => {
  it('updates one stable message while streaming and finalizes it in place', async () => {
    const channel = new CLIChannel();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const result = channel.stream((async function* () {
      yield 'Hello';
      await gate;
      yield ' world';
    })());

    await new Promise<void>((resolve) => setImmediate(resolve));
    const partial = (channel as any).state.chatMessages;
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatchObject({ content: 'Hello', streaming: true });

    release?.();
    await expect(result).resolves.toBe('Hello world');
    const completed = (channel as any).state.chatMessages;
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ id: partial[0].id, content: 'Hello world', streaming: false });
  });

  it('clamps code scrolling to the last full viewport instead of the last line', () => {
    const channel = channelWithWorkspace();

    channel.scrollWorkspaceCode(1_000, 20);
    expect((channel as any).state.workspace.codeScrollOffset).toBe(80);

    channel.scrollWorkspaceCode(-1_000, 20);
    expect((channel as any).state.workspace.codeScrollOffset).toBe(0);
  });

  it('stores workspace chat scrolling as a non-negative distance from the bottom', () => {
    const channel = channelWithWorkspace();

    channel.scrollWorkspaceChat(12);
    expect((channel as any).state.workspace.chatScrollOffset).toBe(12);

    channel.scrollWorkspaceChat(-20);
    expect((channel as any).state.workspace.chatScrollOffset).toBe(0);
  });

  it('normalizes CRLF file previews before measuring terminal rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mercury-tui-'));
    cleanup.push(dir);
    const filePath = join(dir, 'windows.txt');
    writeFileSync(filePath, 'one\r\ntwo\r\nthree');
    const channel = new CLIChannel();

    expect((channel as any).readFilePreview(filePath)).toEqual(['one', 'two', 'three']);
  });
});
