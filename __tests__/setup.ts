import { vi } from 'vitest'

// @actions/core is ESM-only; its module namespace cannot be spied on directly
vi.mock('@actions/core', { spy: true })
