import pino from 'pino';
import { redactDeep } from './redact.js';

const verbose = process.argv.includes('--verbose') || process.argv.includes('-v');
const level = process.env.LOG_LEVEL || (verbose ? 'info' : 'silent');

/**
 * Error serializer: provider errors carry response bodies that embed API-key
 * fragments — those must never reach persistent logs unredacted.
 */
const redactedError = (err: unknown): unknown => redactDeep(err);

export const logger = pino({
  level,
  name: 'mercury',
  serializers: {
    err: redactedError,
    error: redactedError,
  },
}, pino.destination(2),
);