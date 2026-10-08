import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: false,
    setupFiles: ['__tests__/setup.ts'],
    // Mirrors Jest's `clearMocks: true` + `resetMocks: true` + `restoreMocks: true`.
    // Note: Vitest's mockReset restores a spy's original implementation (Jest 29
    // reset it to return undefined); the suite passes identically under both semantics.
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // lcovonly + json-summary are machine-readable for CI artifacts and job summaries
      reporter: ['text', 'text-summary', 'lcovonly', 'json-summary'],
      thresholds: {
        lines: 95,
        branches: 93,
        functions: 98,
        statements: 95,
      },
    },
  },
})
