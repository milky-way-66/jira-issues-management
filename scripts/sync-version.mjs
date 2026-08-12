#!/usr/bin/env node
/**
 * Copies the version from package.json into the CLI constant.
 *
 * Wired to npm's `version` lifecycle, so `npm version patch` updates both in one
 * commit. It exists because the two drifted once: 0.1.1 was published reporting
 * itself as 0.1.0, and that number is what `cli_range` checks — a gate with no
 * bypass flag. A workspace pinning `>=0.1.1` would have refused a correct CLI,
 * and the message would have named a version the user could see was installed.
 *
 * TC-E-SAFE-15f fails the build if they disagree, so this script being forgotten
 * is caught rather than shipped.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const target = join(root, 'src/adapters/workspace.ts')

const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const source = await readFile(target, 'utf8')

const pattern = /^export const CLI_VERSION = '.*'$/m
if (!pattern.test(source)) {
  console.error(`no CLI_VERSION declaration found in ${target}`)
  process.exit(1)
}

const updated = source.replace(pattern, `export const CLI_VERSION = '${version}'`)
if (updated === source) {
  console.log(`CLI_VERSION already ${version}`)
} else {
  await writeFile(target, updated, 'utf8')
  console.log(`CLI_VERSION → ${version}`)
}
