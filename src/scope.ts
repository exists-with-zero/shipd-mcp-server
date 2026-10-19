// What the current HTTP request asked for, readable deep inside a tool handler.
//
// The SDK does not tell a task tool's handler whether the client asked for a
// task: `taskRequestedTtl` is also empty for a task request without a ttl. The
// raw body does say, so http.ts records it here for the length of the request.

import { AsyncLocalStorage } from "node:async_hooks";

interface CallScope {
  /** The request is a tools/call that asked to run as a task. */
  taskCall: boolean;
}

const scope = new AsyncLocalStorage<CallScope>();

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Run `fn` with the scope of this request body. */
export function withCallScope<T>(body: unknown, fn: () => Promise<T>): Promise<T> {
  const taskCall =
    isObject(body) &&
    body.method === "tools/call" &&
    isObject(body.params) &&
    body.params.task !== undefined &&
    body.params.task !== null;
  return scope.run({ taskCall }, fn);
}

/** Did the client ask for a task? Unknown (no scope) counts as yes, which keeps
 * the SDK's own task behaviour. */
export function askedForTask(): boolean {
  return scope.getStore()?.taskCall ?? true;
}
