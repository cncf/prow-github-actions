import { beforeEach, chai, vi } from 'vitest'

import { actionsPlatform } from '../src/adapters/actions'
import { setPlatform } from '../src/platform'

// @actions/core is ESM-only; its module namespace cannot be spied on directly
vi.mock('@actions/core', { spy: true })

// `toThrow(message)` delegates to chai's `throws`, which compares the message
// only when the caught value is truthy (chaijs/chai#1609,
// vitest-dev/vitest#7260): `throw undefined` satisfies `toThrow('anything')`.
// A helper that should build an Error but returns nothing — the shape a
// Stryker block mutant produces — would therefore pass every message
// assertion in this suite. Fail the assertion when the thrown value is
// nullish instead, for the sync form and for `.rejects`, which vitest routes
// through the same chai method.
chai.use((_chai, utils) => {
  for (const method of ['throw', 'throws', 'Throw']) {
    utils.overwriteMethod(_chai.Assertion.prototype, method, _super => function (this: object, ...args: unknown[]) {
      const object: unknown = utils.flag(this, 'object')
      const negate = Boolean(utils.flag(this, 'negate'))
      const promise = utils.flag(this, 'promise')
      let thrown: { value: unknown } | undefined

      if (promise === 'rejects') {
        thrown = { value: object }
      }
      else if (typeof object === 'function' && !negate) {
        utils.flag(this, 'object', () => {
          try {
            return object()
          }
          catch (error) {
            thrown = { value: error }
            throw error
          }
        })
      }

      _super.apply(this, args)

      if (!negate && thrown !== undefined && (thrown.value === undefined || thrown.value === null)) {
        throw new _chai.AssertionError(
          `expected an error to be thrown, but ${thrown.value === null ? 'null' : 'undefined'} was thrown`,
          { showDiff: false },
          utils.flag(this, 'ssfi'),
        )
      }
    })
  }
})

// (re)installed before every test: a test may swap in its own platform
setPlatform(actionsPlatform())
beforeEach(() => setPlatform(actionsPlatform()))
