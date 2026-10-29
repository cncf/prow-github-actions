import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: false,
    setupFiles: ['__tests__/setup.ts'],
    globalSetup: ['__tests__/worker/globalSetup.ts'],
    // Mirrors Jest's `clearMocks: true` + `resetMocks: true` + `restoreMocks: true`.
    // Note: Vitest's mockReset restores a spy's original implementation (Jest 29
    // reset it to return undefined); the suite passes identically under both semantics.
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // the Worker runs only inside workerd (__tests__/worker, via miniflare), where V8 coverage
      // does not reach; its behaviour is tested there, its lines are not counted here
      exclude: ['src/server/worker.ts', 'src/server/worker-env.d.ts'],
      // lcovonly + json-summary are machine-readable for CI artifacts and job summaries
      reporter: ['text', 'text-summary', 'lcovonly', 'json-summary'],
      // Regression floor set just under what main reaches (100 / 99.7 / 100 / 100
      // at 1062ce7) so a drop of about one point fails build-test.
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
})
