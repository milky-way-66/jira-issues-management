#!/usr/bin/env node
/**
 * Entry point. Deliberately thin: it turns an exit code into a process exit and
 * nothing else, so every path through the CLI stays reachable from a test that
 * calls `run()` directly.
 */

import { run } from './adapters/cli.js'

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message ?? err}\n`)
    process.exitCode = 1
  })
