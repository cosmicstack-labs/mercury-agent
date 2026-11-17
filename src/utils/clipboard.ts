import { spawnSync } from 'node:child_process';

/** Put text on this computer's clipboard. False when no clipboard tool is available. */
export function copyToClipboard(text: string): boolean {
  const tools: Array<[string, string[]]> =
    process.platform === 'darwin' ? [['pbcopy', []]]
      : process.platform === 'win32' ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  for (const [cmd, args] of tools) {
    try {
      const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 3000 });
      if (r.status === 0) return true;
    } catch { /* try the next tool */ }
  }
  return false;
}

type Select = (title: string, options: Array<{ value: string; label: string }>) => Promise<string | null | undefined>;

/**
 * Show a secret until it's acknowledged, offering to copy `copy` to the
 * clipboard: a long token wraps in a narrow terminal, and copying it by hand
 * then picks up line breaks and box borders.
 */
export async function acknowledgeSecret(select: Select, text: string, copy?: string): Promise<void> {
  let title = text;
  for (;;) {
    const options = copy
      ? [{ value: 'copy', label: 'Copy to clipboard' }, { value: 'ok', label: "Done, I've saved it" }]
      : [{ value: 'ok', label: "I've copied it" }];
    const picked = await select(title, options);
    if (picked !== 'copy' || !copy) return;
    title = copyToClipboard(copy)
      ? `${text}\n\n✓ Copied to the clipboard.`
      : `${text}\n\nCouldn't reach the clipboard here: select the token above and copy it.`;
  }
}
