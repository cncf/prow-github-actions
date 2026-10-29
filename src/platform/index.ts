import type { Platform } from './types'

export type * from './types'

let current: Platform | undefined

export function setPlatform(next: Platform): void {
  current = next
}

export function platform(): Platform {
  if (!current) {
    throw new Error('no platform installed: the entry point must call setPlatform() before dispatching an event')
  }
  return current
}
