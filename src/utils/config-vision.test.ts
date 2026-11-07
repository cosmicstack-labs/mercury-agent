import { afterEach, describe, expect, it } from 'vitest';
import { getDefaultConfig } from './config.js';
import { modelSeesImages } from '../core/attachments.js';

/**
 * "Not declared" is a third state, not `false`.
 *
 * The three self-hosted endpoints (`openaiCompat`, `lmStudio`, `litellm`) used to default their
 * capability flag to `false` through `getEnvBool(…, false)`. A `false` is a declaration: it turned
 * images off for every model whose name the guesser would have let through (`gpt-4o` behind a
 * gateway), which is the opposite of what a missing variable should mean. Undefined keeps the guess.
 */
const KEYS = ['OPENAI_COMPAT_VISION', 'LM_STUDIO_VISION', 'LITELLM_VISION'] as const;
const saved = new Map<string, string | undefined>();

function unsetAll(): void {
  for (const key of KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

describe('a capability flag nobody set', () => {
  it('stays undefined, so the name guess still runs for openaiCompat', () => {
    unsetAll();
    const config = getDefaultConfig();
    expect(config.providers.openaiCompat.vision).toBeUndefined();
    // Today's behaviour, pinned: a gateway serving gpt-4o still gets the photos.
    expect(modelSeesImages('openaiCompat', 'gpt-4o', config.providers.openaiCompat.vision)).toBe(true);
  });

  it('stays undefined for lmStudio and litellm too', () => {
    unsetAll();
    const config = getDefaultConfig();
    expect(config.providers.lmStudio.vision).toBeUndefined();
    expect(config.providers.litellm.vision).toBeUndefined();
  });

  it('a model the guesser does not recognise still gets the note, not the image', () => {
    unsetAll();
    const config = getDefaultConfig();
    expect(modelSeesImages('openaiCompat', 'qwen3.8-flash-next', config.providers.openaiCompat.vision)).toBe(false);
  });
});

describe('a capability flag the owner set', () => {
  it('false is a declaration and wins over the name guess', () => {
    unsetAll();
    process.env.OPENAI_COMPAT_VISION = 'false';
    const config = getDefaultConfig();
    expect(config.providers.openaiCompat.vision).toBe(false);
    expect(modelSeesImages('openaiCompat', 'gpt-4o', config.providers.openaiCompat.vision)).toBe(false);
  });

  it('true is a declaration and wins over an unrecognised name', () => {
    unsetAll();
    process.env.OPENAI_COMPAT_VISION = 'true';
    const config = getDefaultConfig();
    expect(config.providers.openaiCompat.vision).toBe(true);
    expect(modelSeesImages('openaiCompat', 'qwen3.8-flash-next', config.providers.openaiCompat.vision)).toBe(true);
  });

  it('an unreadable value is the same as not declared', () => {
    unsetAll();
    process.env.LITELLM_VISION = 'maybe';
    const config = getDefaultConfig();
    expect(config.providers.litellm.vision).toBeUndefined();
  });
});
