// Preloaded into the bundle child with `NODE_OPTIONS=--require` by the tide e2e tests.
// Shortens the `setTimeout` waits whose delays are listed (in ms, comma-separated) in
// SHORT_BACKOFF_MS to SHORT_BACKOFF_TO_MS, so tide's 1s+2s+4s mergeability backoff runs
// in milliseconds without changing what the bundle logs. Every other timer is untouched.
'use strict'

const shortened = new Set((process.env.SHORT_BACKOFF_MS ?? '').split(',').filter(Boolean).map(Number))
const to = Number(process.env.SHORT_BACKOFF_TO_MS ?? '10')
const realSetTimeout = globalThis.setTimeout

function shortSetTimeout(callback, delay, ...args) {
  return realSetTimeout(callback, shortened.has(delay) ? to : delay, ...args)
}
shortSetTimeout.__promisify__ = realSetTimeout.__promisify__
globalThis.setTimeout = shortSetTimeout
