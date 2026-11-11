/**
 * "The owner already approved this exact tool call" (ADR-044). The
 * injection guard asks first, with what was read and the full arguments;
 * the tool's own approval (a shell command, a scheduled task) then needn't
 * ask again. Carried by AsyncLocalStorage through that one call only, so a
 * tool running in parallel never inherits the yes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const approved = new AsyncLocalStorage<true>();

export function runOwnerApproved<T>(fn: () => T): T {
  return approved.run(true, fn);
}

export function ownerApprovedThisCall(): boolean {
  return approved.getStore() === true;
}
