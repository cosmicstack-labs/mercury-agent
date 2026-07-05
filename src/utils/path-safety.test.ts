import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { isPathInsideRoot } from './path-safety.js';

describe('isPathInsideRoot', () => {
  const root = '/home/user/mercury';

  it('allows the workspace root itself', () => {
    expect(isPathInsideRoot(root, root)).toBe(true);
  });

  it('allows paths inside the workspace', () => {
    expect(isPathInsideRoot(join(root, 'src/index.ts'), root)).toBe(true);
  });

  it('rejects prefix-bypass paths (mercury vs mercury-private)', () => {
    expect(isPathInsideRoot('/home/user/mercury-private/secret.env', root)).toBe(false);
  });

  it('rejects parent traversal', () => {
    expect(isPathInsideRoot(join(root, '..', 'outside.txt'), root)).toBe(false);
  });
});
