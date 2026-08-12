import { defineConfig } from 'vitest/config'

// TZ is pinned so timezone handling is exercised deliberately rather than
// depending on whatever the developer's machine happens to be set to.
process.env.TZ = 'Asia/Tokyo'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // test/live/ talks to a real instance. It is opt-in via `npm run test:live`
    // and excluded here so the default run can never reach a tracker — the
    // file's own env guard would skip it, but excluding it makes that a
    // property of the configuration rather than of remembering to check.
    exclude: ['node_modules/**', 'test/live/**'],
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
