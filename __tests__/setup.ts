import { beforeEach, vi } from 'vitest'

import { actionsPlatform } from '../src/adapters/actions'
import { setPlatform } from '../src/platform'

// @actions/core is ESM-only; its module namespace cannot be spied on directly
vi.mock('@actions/core', { spy: true })

// (re)installed before every test: a test may swap in its own platform
setPlatform(actionsPlatform())
beforeEach(() => setPlatform(actionsPlatform()))
