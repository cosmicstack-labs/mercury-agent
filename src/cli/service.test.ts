import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  buildWindowsCreateTaskArgs,
  buildWindowsTaskCommand,
  getDistPath,
} from './service.js';

describe('service helpers', () => {
  it('uses the current CLI entrypoint as the service script path', () => {
    const entrypoint = '/home/test/.npm/node_modules/@cosmicstack/mercury-agent/dist/index.js';

    expect(getDistPath(entrypoint)).toBe(resolve(entrypoint));
    expect(getDistPath(entrypoint)).not.toContain('lib/node_modules');
  });

  it('builds a Windows task action that preserves paths with spaces', () => {
    const command = buildWindowsTaskCommand(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Users\\chris\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js',
    );

    expect(command).toBe(
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\chris\\AppData\\Roaming\\npm\\node_modules\\@cosmicstack\\mercury-agent\\dist\\index.js" start --daemon',
    );
  });

  it('passes the Windows task action as one schtasks argument', () => {
    const taskCommand = buildWindowsTaskCommand(
      'C:\\Program Files\\nodejs\\node.exe',
      'C:\\Mercury Agent\\dist\\index.js',
    );

    expect(buildWindowsCreateTaskArgs('MercuryAgent', taskCommand)).toEqual([
      '/create',
      '/tn',
      'MercuryAgent',
      '/tr',
      '"C:\\Program Files\\nodejs\\node.exe" "C:\\Mercury Agent\\dist\\index.js" start --daemon',
      '/sc',
      'onlogon',
      '/rl',
      'limited',
      '/f',
    ]);
  });
});
