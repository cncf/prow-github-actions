// the Workers runtime provides node:async_hooks under nodejs_compat; its types come from
// @types/node, which cannot be loaded next to @cloudflare/workers-types, so declare the one import used
declare module 'node:async_hooks' {
  export class AsyncLocalStorage<T> {
    getStore: () => T | undefined
    run: <R>(store: T, callback: () => R) => R
  }
}
