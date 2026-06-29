// Invocation-scoped runtime, threaded implicitly so the free `run()` function
// (called inside a handler as `run(event, [...])`) can reach the plugin manager,
// signal, and loggers without the public `DetectedEvent`/handler signature
// carrying any of it. `handle()` runs the handler inside `invocationStore.run(rt,
// …)`; `run()` reads it back with `invocationStore.getStore()`.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { InvocationContext } from '../core/index.js';
import type { PluginManager } from './plugin-manager.js';

export interface InvocationRuntime {
  pluginManager: PluginManager;
  invocation: InvocationContext;
  signal: AbortSignal;
}

export const invocationStore = new AsyncLocalStorage<InvocationRuntime>();

/** The current invocation runtime, or undefined if called outside `handle()`. */
export const currentRuntime = (): InvocationRuntime | undefined => invocationStore.getStore();
