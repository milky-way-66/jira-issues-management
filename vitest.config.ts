import { defineConfig } from 'vitest/config'

// TZ is pinned so timezone handling is exercised deliberately rather than
// depending on whatever the developer's machine happens to be set to.
process.env.TZ = 'Asia/Tokyo'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/core/merge3.ts', 'src/core/policy.ts'],
      thresholds: {
        // These two files decide what happens to real tickets in a shared
        // system. Everything else is deliberately left without a threshold:
        // a global percentage target produces tests written to raise a number.
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
})
