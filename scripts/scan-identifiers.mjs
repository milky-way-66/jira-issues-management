#!/usr/bin/env node
/**
 * Fails the build if project-specific identifiers appear anywhere in the
 * repository.
 *
 * This is not only a confidentiality measure. It is the test of whether the
 * architecture holds: if a customer hostname or project key ever *has* to be
 * hard-coded into the tool, project-specific logic has leaked into the core.
 *
 * The forbidden list itself is deliberately kept out of the repository — it
 * would otherwise be the very leak it guards against. Supply it via
 * MGMT_FORBIDDEN (comma-separated) in CI.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SKIP = new Set(['node_modules', '.git', 'dist', 'coverage'])
const EXT = /\.(ts|js|mjs|json|md|ya?ml)$/

/** Always forbidden, regardless of environment: real-looking credentials. */
const ALWAYS = [
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'Atlassian API token', re: /\bATATT[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
]

const extra = (process.env.MGMT_FORBIDDEN ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => ({ name: `forbidden identifier "${s}"`, re: new RegExp(s, 'i') }))

const RULES = [...ALWAYS, ...extra]

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else if (EXT.test(entry.name)) yield full
  }
}

let failures = 0

for await (const file of walk(ROOT)) {
  // The scanner necessarily contains the patterns it looks for.
  if (file.endsWith('scan-identifiers.mjs')) continue

  const text = await readFile(file, 'utf8')
  for (const rule of RULES) {
    if (rule.re.test(text)) {
      console.error(`✗ ${relative(ROOT, file)}: ${rule.name}`)
      failures++
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} violation(s). This repository is public — see docs/README.md.`)
  process.exit(1)
}

console.log(`✓ identifier scan clean (${RULES.length} rules)`)
