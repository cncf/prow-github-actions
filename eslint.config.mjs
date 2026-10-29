import antfu from '@antfu/eslint-config'

export default antfu({
  ignores: [
    'dist/',
    '**/dist/**/',
    'lib/',
    '**/lib/**/',
    'node_modules/',
    '**/node_modules/**/',
  ],
}, {
  files: ['__tests__/**/*.test.ts'],
  rules: {
    // A test that drives the code but checks nothing passes whatever the code
    // does. The extra names are this suite's own assertion helpers: the
    // expectRequests/expectWindow family in __tests__/bundle and
    // ObserveRequest.called()/notCalled() in __tests__/testUtils.ts, which
    // reject on their own when the observed request is missing or present.
    'test/expect-expect': ['error', {
      assertFunctionNames: ['expect', 'expect*', '*.called', '*.notCalled'],
    }],
  },
}, {
  // the handlers reach the runtime only through src/platform; see docs/overview.md
  files: ['src/**/*.ts'],
  ignores: ['src/adapters/**', 'src/main.ts', 'src/server/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [
        { group: ['@actions/*'], message: 'import from the platform instead; only src/adapters may use @actions/*' },
        { group: ['node:*'], message: 'the core must not depend on Node; only src/adapters may import node:*' },
      ],
    }],
  },
})
