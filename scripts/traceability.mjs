#!/usr/bin/env node
/**
 * Links the test specification to the test code, in both directions.
 *
 * Two failures this prevents:
 *
 *   1. Drift — a case is renamed or deleted in docs/testcase/ while a test still
 *      claims to implement it, or a test is deleted while the case still claims
 *      to be covered. Either way the specification quietly stops describing
 *      reality, which is worse than having no specification.
 *
 *   2. Invisible gaps — no way to answer "how much of the spec is automated?"
 *      without reading every file.
 *
 * Convention: a test implements a case when its name begins with the case id.
 * A trailing letter marks a variant of the same case (TC-U-MERGE-08b covers
 * TC-U-MERGE-08), so implementers can split a case without editing the docs.
 *
 * Usage:
 *   node scripts/traceability.mjs            report + enforce the ratchet
 *   node scripts/traceability.mjs --gaps     list cases that have no test code
 *   node scripts/traceability.mjs --area U   restrict to a layer or area
 *   node scripts/traceability.mjs --json     machine-readable
 *   node scripts/traceability.mjs --update   accept the current numbers
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const SPEC_DIR = join(ROOT, 'docs/testcase')
const TEST_DIR = join(ROOT, 'test')
const BASELINE = join(ROOT, 'docs/testcase/.automated-baseline.json')

const CASE_ID = /\bTC-[UIE]-[A-Z]+-\d+/g
/** Ids as written in test names, where a trailing letter marks a variant. */
const TEST_ID = /\bTC-[UIE]-[A-Z]+-\d+[a-z]?\b/g

const args = process.argv.slice(2)
const argv = new Set(args)
const areaFilter = (() => {
  const i = args.indexOf('--area')
  return i === -1 ? null : (args[i + 1] ?? '').toUpperCase()
})()

async function* walk(dir, ext) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full, ext)
    else if (e.name.endsWith(ext)) yield full
  }
}

/** Case ids declared in the specification, with the file that declares them. */
async function readSpec() {
  const declared = new Map() // id -> file
  const duplicates = []

  for await (const file of walk(SPEC_DIR, '.md')) {
    const text = await readFile(file, 'utf8')
    const seenHere = new Set()

    for (const line of text.split('\n')) {
      // A case is *declared* where it is defined — a bold id or a table row —
      // not merely where it is cross-referenced in prose.
      const declaration = line.match(/^\s*(?:\|\s*)?\*\*(TC-[UIE]-[A-Z]+-\d+)\*\*/)
      if (!declaration) continue

      const id = declaration[1]
      if (seenHere.has(id)) continue
      seenHere.add(id)

      if (declared.has(id)) duplicates.push({ id, files: [declared.get(id), file] })
      else declared.set(id, relative(ROOT, file))
    }
  }

  return { declared, duplicates }
}

/** Case ids claimed by test code, with the file claiming them. */
async function readTests() {
  const claimed = new Map() // id -> Set<file>

  for await (const file of walk(TEST_DIR, '.test.ts')) {
    const text = await readFile(file, 'utf8')
    for (const [raw] of text.matchAll(TEST_ID)) {
      const base = raw.replace(/[a-z]$/, '')
      if (!claimed.has(base)) claimed.set(base, new Set())
      claimed.get(base).add(relative(ROOT, file))
    }
  }

  return claimed
}

function areaOf(id) {
  const m = id.match(/^TC-([UIE])-([A-Z]+)-/)
  return m ? `${m[1]}/${m[2]}` : 'unknown'
}

const { declared, duplicates } = await readSpec()
const claimed = await readTests()

const automated = [...declared.keys()].filter((id) => claimed.has(id))
const gaps = [...declared.keys()].filter((id) => !claimed.has(id))
const orphans = [...claimed.keys()].filter((id) => !declared.has(id))

// Per-area breakdown, so a phase's progress is visible at a glance.
const areas = new Map()
for (const id of declared.keys()) {
  const a = areaOf(id)
  if (!areas.has(a)) areas.set(a, { total: 0, done: 0 })
  areas.get(a).total++
  if (claimed.has(id)) areas.get(a).done++
}

let baseline = { automated: 0 }
try {
  baseline = JSON.parse(await readFile(BASELINE, 'utf8'))
} catch {
  /* first run */
}

const report = {
  declared: declared.size,
  automated: automated.length,
  percent: declared.size === 0 ? 0 : Math.round((automated.length / declared.size) * 100),
  gaps,
  orphans: orphans.map((id) => ({ id, files: [...claimed.get(id)] })),
  duplicates,
  baseline: baseline.automated,
  areas: Object.fromEntries([...areas].sort().map(([k, v]) => [k, `${v.done}/${v.total}`])),
}

if (argv.has('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
}

if (argv.has('--update')) {
  await writeFile(BASELINE, JSON.stringify({ automated: automated.length }, null, 2) + '\n')
  console.log(`baseline updated to ${automated.length} automated cases`)
  process.exit(0)
}

if (!argv.has('--json')) {
  console.log('Traceability — specification ↔ test code\n')
  console.log(`  declared cases   ${report.declared}`)
  console.log(`  automated        ${report.automated}  (${report.percent}%)`)
  console.log(`  not yet written  ${gaps.length}\n`)

  const width = Math.max(...[...areas.keys()].map((a) => a.length), 4)
  for (const [area, counts] of Object.entries(report.areas)) {
    const [done, total] = counts.split('/').map(Number)
    const bar = '█'.repeat(Math.round((done / total) * 20)).padEnd(20, '·')
    console.log(`  ${area.padEnd(width)}  ${bar}  ${counts}`)
  }

  if (argv.has('--gaps')) {
    const shown = gaps.filter((id) => !areaFilter || areaOf(id).includes(areaFilter))

    if (shown.length === 0) {
      console.log(
        `\n  ✓ every declared case${areaFilter ? ` in ${areaFilter}` : ''} has test code.`,
      )
    } else {
      console.log(`\n  Cases with no test code (${shown.length}):\n`)
      let lastArea = null
      for (const id of shown.sort()) {
        const area = areaOf(id)
        if (area !== lastArea) {
          console.log(`  ${area}   ${declared.get(id)}`)
          lastArea = area
        }
        console.log(`      ${id}`)
      }
    }
  } else if (gaps.length > 0) {
    console.log(`\n  Run "npm run trace:gaps" to list the ${gaps.length} case(s) without code.`)
  }
}

let failed = false

// Two ids for the same case: cross-references would be ambiguous and coverage
// counting would be wrong.
if (duplicates.length > 0) {
  console.error('\n✗ duplicate case declarations:')
  for (const d of duplicates) console.error(`    ${d.id} in ${d.files.join(' and ')}`)
  failed = true
}

// A test citing a case that no longer exists. This is the drift guard: the
// specification was edited and the test was not, or the id is a typo — in both
// cases the "coverage" it appeared to provide was imaginary.
if (orphans.length > 0) {
  console.error('\n✗ tests reference cases that are not declared in the specification:')
  for (const o of report.orphans) console.error(`    ${o.id}  (${o.files.join(', ')})`)
  console.error('    Either the case was renamed or removed, or the id is a typo.')
  failed = true
}

// Ratchet: automation may not go backwards. Gaps are expected while phases are
// still unwritten, but a case that *was* automated must not silently lose it.
if (automated.length < baseline.automated) {
  console.error(
    `\n✗ automated coverage fell from ${baseline.automated} to ${automated.length} cases.`,
  )
  console.error('    If a case was intentionally retired, run: npm run trace -- --update')
  failed = true
}

if (!failed && automated.length > baseline.automated && !argv.has('--json')) {
  console.log(
    `\n  ↑ ${automated.length - baseline.automated} newly automated — run "npm run trace -- --update" to lock it in.`,
  )
}

process.exit(failed ? 1 : 0)
