/**
 * TC-E-SAFE — docs/testcase/e2e/TC-E-safety.md
 *
 * These are the cases that justify the safety claims in the documentation.
 * Each one exists because the failure it prevents is expensive: a write to a
 * customer's repository, a leaked token, a workspace erased by a partial
 * remote response.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { GithubIssueSource } from '../../src/adapters/github.js'
import {
  FixedClock,
  InMemoryTicketRepo,
  InMemoryTracker,
} from '../../src/adapters/in-memory.js'
import { execute, plan } from '../../src/core/use-cases/sync-tickets.js'
import type { FieldSet, RemoteTicket, Ticket } from '../../src/core/ticket.js'
import { FakeJira } from '../support/fake-jira.js'

const exec = promisify(execFile)
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let root: string
let jira: FakeJira
let baseUrl: string

function io(over: Partial<Io> = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    cwd: root,
    env: { JIRA_PAT: jira.token },
    ...over,
  }
}

async function writeConfig(schemaVersion = 1): Promise<void> {
  await writeFile(
    join(root, 'config.yml'),
    [
      '# A comment that must survive migration.',
      'mgmt:',
      `  schema_version: ${schemaVersion}`,
      '  cli_range: ">=0.1.0 <0.2.0"',
      'jira:',
      `  base_url: "${baseUrl}"`,
      '  project: "PROJ"',
      `  epic_link_field: "${jira.epicLinkField}"`,
      'github:',
      '  repos: []',
      '',
    ].join('\n'),
    'utf8',
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-safe-'))
  jira = new FakeJira()
  baseUrl = await jira.start()
  await run(['init'], io())
  await writeConfig()
})

afterEach(async () => {
  await jira.stop()
  await rm(root, { recursive: true, force: true })
})

describe('TC-E-SAFE — credentials', () => {
  it('TC-E-SAFE-02 the suite runs with no real credentials', async () => {
    // Nothing in the test tree may depend on a real token being present. If a
    // case ever starts reading one, this fails on every machine but the author's.
    const leaked = ['JIRA_PAT', 'GITHUB_TOKEN', 'ATLASSIAN_TOKEN']
      .filter((name) => (process.env[name] ?? '') !== '')

    expect(leaked).toEqual([])

    // And the tracker under test is the substitute, on loopback.
    expect(new URL(baseUrl).hostname).toBe('127.0.0.1')
  })
})

describe('TC-E-SAFE — the external source is never written to', () => {
  it('TC-E-SAFE-03 no non-GET request reaches the external source', async () => {
    const methods: string[] = []

    const source = new GithubIssueSource({
      repos: [{ owner: 'acme', repo: 'app' }],
      baseUrl: 'https://api.example.test',
      fetch: async (_url, init) => {
        methods.push(init?.method ?? 'GET')
        return new Response('[]', { status: 200 })
      },
    })

    // Every method the port exposes, exercised.
    for await (const _ of source.fetchUpdatedSince(null)) void _
    for await (const _ of source.fetchAll()) void _

    expect(methods).not.toHaveLength(0)
    expect([...new Set(methods)]).toEqual(['GET'])
  })
})

describe('TC-E-SAFE — schema migration', () => {
  it('TC-E-SAFE-06 mgmt migrate raises the schema version in an isolated change', async () => {
    await writeConfig(0)

    // The workspace is unusable until migrated — that is what the code means.
    expect(await run(['status'], io())).toBe(EXIT.incompatible)

    const o = io()
    expect(await run(['migrate'], o)).toBe(EXIT.ok)
    expect(o.stdout.join('\n')).toContain('0 → 1')

    const config = await readFile(join(root, 'config.yml'), 'utf8')
    expect(config).toContain('schema_version: 1')
    // A migration has to be reviewable as a diff, so nothing else may move.
    expect(config).toContain('# A comment that must survive migration.')
    expect(config).toContain('cli_range: ">=0.1.0 <0.2.0"')

    expect([EXIT.ok, EXIT.conflicts]).toContain(await run(['status'], io()))
  })

  it('TC-E-SAFE-06b migrating an up-to-date workspace changes nothing', async () => {
    const before = await readFile(join(root, 'config.yml'), 'utf8')

    const o = io()
    expect(await run(['migrate'], o)).toBe(EXIT.ok)

    expect(await readFile(join(root, 'config.yml'), 'utf8')).toBe(before)
    expect(o.stdout.join('\n')).toContain('already at schema version')
  })
})

describe('TC-E-SAFE — partial failure', () => {
  const BASE_FIELDS: FieldSet = {
    title: 'Review monitoring documentation',
    body: 'Original body.',
    status: 'To Do',
    assignee: 'alice',
    type: 'Task',
    parent: null,
    labels: ['docs-qa'],
    priority: 'Medium',
    estimate: null,
    due: null,
  }

  function ticket(id: string, over: Partial<FieldSet> = {}): Ticket {
    return {
      id,
      fields: { ...BASE_FIELDS, ...over },
      jira: { key: id, url: '', updated: '2026-08-11T09:00:00+09:00' },
      sync: { base: 'x', lastPull: null, lastPush: null, conflict: false },
    }
  }

  function snapshot(key: string): RemoteTicket {
    return { key, updated: '2026-08-11T09:00:00+09:00', fields: { ...BASE_FIELDS } }
  }

  it('TC-E-SAFE-08 a partial failure leaves a consistent workspace', async () => {
    const repo = new InMemoryTicketRepo([
      ticket('PROJ-1', { body: 'Edit one.' }),
      ticket('PROJ-2', { body: 'Edit two.' }),
      ticket('PROJ-3', { body: 'Edit three.' }),
    ])
    for (const id of ['PROJ-1', 'PROJ-2', 'PROJ-3']) repo.seedBase(id, snapshot(id))

    const tracker = new InMemoryTracker({
      pages: [[snapshot('PROJ-1'), snapshot('PROJ-2'), snapshot('PROJ-3')]],
      failOn: ['PROJ-2'],
    })
    const deps = { repo, tracker, clock: new FixedClock() }

    const first = await execute(deps, await plan(deps))
    expect(first.failures.map((f) => f.id)).toEqual(['PROJ-2'])

    // Recovery is "run it again", never "repair the state by hand". The second
    // run sees a tracker that did accept the two successful pushes, and must
    // pick up exactly the ticket that failed — and only that one.
    const accepted = (key: string, body: string): RemoteTicket => ({
      ...snapshot(key),
      fields: { ...BASE_FIELDS, body },
    })
    const tracker2 = new InMemoryTracker({
      pages: [[accepted('PROJ-1', 'Edit one.'), snapshot('PROJ-2'), accepted('PROJ-3', 'Edit three.')]],
    })
    const deps2 = { repo, tracker: tracker2, clock: new FixedClock() }

    const retryPlan = await plan(deps2)
    expect(retryPlan.plan.tickets.map((t) => t.id)).toEqual(['PROJ-2'])

    const second = await execute(deps2, retryPlan)
    expect(second.failures).toEqual([])
    expect(repo.peekBase('PROJ-2')?.fields.body).toBe('Edit two.')
  })

  it('TC-E-SAFE-09 a remote omitting tickets deletes nothing locally', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1'), ticket('PROJ-2'), ticket('PROJ-3')])
    for (const id of ['PROJ-1', 'PROJ-2', 'PROJ-3']) repo.seedBase(id, snapshot(id))

    // The tracker answers with nothing at all — a truncated response, an
    // outage, a mis-scoped query. Absence is not deletion.
    const tracker = new InMemoryTracker({ pages: [[]] })
    const deps = { repo, tracker, clock: new FixedClock() }

    await execute(deps, await plan(deps))

    expect(await repo.list()).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
    expect(repo.calls.some((c) => c.method === 'archive')).toBe(false)
  })
})

describe('TC-E-SAFE — repository hygiene', () => {
  it('TC-E-SAFE-14 the published package contains no project-specific identifiers', async () => {
    // The scan is the same one `npm run check` runs; asserting it here means a
    // leak fails the test suite, not just the release script.
    const { stdout } = await exec('node', ['scripts/scan-identifiers.mjs'], { cwd: packageRoot })
    expect(stdout).toContain('clean')
  })

  it('TC-E-SAFE-15 the package tarball contains only the allowlisted paths', async () => {
    const { stdout } = await exec(
      'npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      { cwd: packageRoot, maxBuffer: 10 * 1024 * 1024 },
    )

    // npm prefixes its own progress lines; the JSON payload starts at the array.
    const json = stdout.slice(stdout.indexOf('['))
    const [result] = JSON.parse(json) as { files: { path: string }[] }[]
    const paths = (result?.files ?? []).map((f) => f.path)

    expect(paths).not.toHaveLength(0)

    for (const path of paths) {
      expect(path).toMatch(/^(dist\/|templates\/|README\.md$|package\.json$|LICENSE)/)
    }

    // The things whose presence would matter most.
    expect(paths.some((p) => p.startsWith('test/'))).toBe(false)
    expect(paths.some((p) => p.includes('.env'))).toBe(false)
    expect(paths.some((p) => p.startsWith('docs/'))).toBe(false)
  })

  it('TC-E-SAFE-15c the built binary actually runs', async () => {
    // The suite otherwise runs against src/. Bundling a CommonJS dependency
    // into the ESM output crashes on the first command — green tests, dead
    // binary — so the artefact users install is exercised here.
    await exec('npm', ['run', 'build'], { cwd: packageRoot })

    const { stdout } = await exec('node', [join(packageRoot, 'dist/main.js'), '--version'])
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)

    const help = await exec('node', [join(packageRoot, 'dist/main.js'), '--help'])
    expect(help.stdout).toContain('sync')
  }, 60_000)

  it('TC-E-SAFE-15b templates ship with the package, or init cannot work', async () => {
    // A global install with no templates/ fails at `mgmt init`, which is the
    // first thing a new user runs.
    const files = await readdir(join(packageRoot, 'templates'))
    expect(files).toContain('config.yml')
  })
})
