/**
 * One rule, shared by every adapter that can open a socket: while tests are
 * running, nothing outside loopback may be contacted.
 *
 * It lives in its own file rather than in each adapter because a safety rule
 * that exists in two copies is a rule that will exist in two versions. Each
 * adapter still throws its own error type — the check is shared, the vocabulary
 * is not.
 *
 * The failure this prevents is expensive and irreversible: a test run pointed at
 * a live tracker, or at a customer's repository. That mistake happens once, at
 * speed, on somebody's laptop, and no amount of care afterwards undoes it.
 */

export function underTest(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.env['VITEST'] !== undefined
}

/**
 * Returns the message to fail with, or null when the host is acceptable.
 *
 * Returning rather than throwing keeps the error type — and therefore what a
 * caller can catch — the adapter's own decision.
 */
export function nonLoopbackUnderTest(baseUrl: string, what: string): string | null {
  if (!underTest()) return null

  const host = new URL(baseUrl).hostname
  const loopback =
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
  if (loopback) return null

  return (
    `refusing to contact ${host} during tests; only loopback is permitted. ` +
    `A test must never reach a real ${what}.`
  )
}
