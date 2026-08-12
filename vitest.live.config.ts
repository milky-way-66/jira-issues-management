import { defineConfig } from 'vitest/config'

// Opt-in suite that talks to a real Jira. Kept in its own config rather than
// reached by flags on the default one: the two runs must not be a typo apart,
// since the difference between them is "no network at all" and "a real tracker".
//
//   MGMT_LIVE_JIRA_URL=http://localhost:8080 \
//   MGMT_LIVE_JIRA_PAT=... \
//   npm run test:live
//
// The cases themselves skip unless those variables are set, and the adapter's
// loopback guard still refuses any non-loopback host.
process.env.TZ = 'Asia/Tokyo'

// Set here rather than by the operator, so that exporting MGMT_LIVE_JIRA_URL in
// a shell can never turn a plain `npm test` into a run that writes to a real
// tracker. Live mode is a property of *which config was used*, not of what
// happens to be in the environment.
process.env['MGMT_LIVE_MODE'] = '1'

export default defineConfig({
  test: {
    include: [
      'test/live/**/*.test.ts',
      // The intake scenario is written against both tracker implementations on
      // purpose: a difference between the two runs is a mapping bug, and the
      // only way to see it is to run the same assertions twice.
      'test/e2e/intake-flow.test.ts',
    ],
    environment: 'node',
    // A real instance is slower than a Map by several orders of magnitude.
    testTimeout: 30_000,
  },
})
