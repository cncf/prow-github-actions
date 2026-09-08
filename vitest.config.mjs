import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    globals: false,
    // Mirrors Jest's `clearMocks: true` + `resetMocks: true` + `restoreMocks: true`.
    // Note: Vitest's mockReset restores a spy's original implementation (Jest 29
    // reset it to return undefined); the suite passes identically under both semantics.
    clearMocks: true,
    mockReset: true,
    restoreMocks: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'text-summary'],
    },
  },
})
