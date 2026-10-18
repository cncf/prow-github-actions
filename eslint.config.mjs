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
})
