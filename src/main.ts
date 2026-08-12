/**
 * Composition root — the only place real adapters are constructed.
 *
 * P0 stub: the core and its tests come first. Commands arrive in P1 once there
 * is something for them to drive.
 */

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[2]

  if (command === '--version' || command === '-v') {
    process.stdout.write('0.1.0\n')
    return 0
  }

  process.stderr.write(
    'mgmt: no commands are implemented yet (P0 — core only).\n' +
      'See docs/cli.md for the planned interface.\n',
  )
  return 1
}

main(process.argv).then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`mgmt: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  },
)
