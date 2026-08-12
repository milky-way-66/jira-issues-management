/**
 * TC-E-INTAKE — docs/testcase/e2e/TC-E-intake-flow.md
 *
 * One continuous scenario, external issue → mirror → ticket → tracker.
 *
 * The tracker is the in-process substitute by default. Set MGMT_LIVE_JIRA_URL
 * and MGMT_LIVE_JIRA_PAT and the *same cases* run against a real Jira
 * (docs/local-jira.md) — that is the point of the switch: the assertions are
 * about behaviour, so a difference between the two runs is a mapping bug, and
 * running them separately would let one drift from the other.
 *
 * The source is always the local mock. There is no live mode for it, ever: this
 * tool is read-only towards someone else's repository, and a test that could
 * reach a real one is a test that could disprove that the hard way.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { JiraTracker } from '../../src/adapters/jira.js'
import { FakeGithub } from '../support/fake-github.js'
import { FakeJira } from '../support/fake-jira.js'

const liveUrl = process.env['MGMT_LIVE_JIRA_URL']
const livePat = process.env['MGMT_LIVE_JIRA_PAT']

// MGMT_LIVE_MODE is set by vitest.live.config.ts, never by hand. Requiring it
// means an exported MGMT_LIVE_JIRA_URL left over in a shell cannot silently turn
// `npm test` into a run that creates issues in a real tracker.
const live = process.env['MGMT_LIVE_MODE'] === '1' && Boolean(liveUrl && livePat)

const REPO = 'acme/app'

let root: string
let gh: FakeGithub
let fakeJira: FakeJira | null = null
let jiraUrl: string
let jiraToken: string
let project: string
let epicField: string | null

function io(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    cwd: root,
    env: { JIRA_PAT: jiraToken },
  }
}

/** Reads the tracker through the adapter, so live and fake are asserted alike. */
function tracker(): JiraTracker {
  return new JiraTracker({
    baseUrl: jiraUrl,
    project,
    token: jiraToken,
    epicLinkField: epicField,
  })
}

async function ticketFile(id: string): Promise<string> {
  return readFile(join(root, 'tickets', `${id}.md`), 'utf8')
}

/** The last request the source received, for asserting on the query it sent. */
function lastSourceRequest(): string {
  const path = gh.requests.at(-1)?.path
  if (!path) throw new Error('the source received no request')
  return path
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-intake-'))

  gh = new FakeGithub({
    perPage: 2, // small enough that four items need three pages
    repos: {
      [REPO]: [
        {
          number: 1,
          title: 'Login fails on Safari',
          body: 'Steps:\n\n1. Open the app\n2. Sign in',
          labels: ['bug'],
          author: 'alice',
          updatedAt: '2026-08-01T10:00:00Z',
        },
        {
          number: 2,
          title: 'Add CSV export',
          body: 'Nice to have.',
          labels: ['enhancement'],
          author: 'bob',
          updatedAt: '2026-08-02T10:00:00Z',
        },
        {
          number: 3,
          title: 'Typo in footer',
          state: 'closed',
          author: 'alice',
          updatedAt: '2026-08-03T10:00:00Z',
        },
        {
          number: 4,
          title: 'Bump dependencies',
          pullRequest: true,
          author: 'bob',
          updatedAt: '2026-08-04T10:00:00Z',
        },
      ],
    },
  })
  const sourceUrl = await gh.start()

  if (live) {
    jiraUrl = liveUrl!
    jiraToken = livePat!
    project = process.env['MGMT_LIVE_JIRA_PROJECT'] ?? 'PROJ'
    // Ask the instance rather than assuming: the id differs per instance, and a
    // wrong guess writes a parent link into an unrelated field.
    epicField = await tracker().discoverEpicLinkField()
  } else {
    fakeJira = new FakeJira()
    jiraUrl = await fakeJira.start()
    jiraToken = fakeJira.token
    project = fakeJira.project
    epicField = fakeJira.epicLinkField
  }

  await run(['init'], io())
  await writeFile(
    join(root, 'config.yml'),
    [
      'mgmt:',
      '  schema_version: 1',
      '  cli_range: ">=0.1.0 <1.0.0"',
      'jira:',
      `  base_url: "${jiraUrl}"`,
      `  project: "${project}"`,
      `  epic_link_field: ${epicField === null ? 'null' : `"${epicField}"`}`,
      'github:',
      `  base_url: "${sourceUrl}"`,
      '  repos:',
      `    - "${REPO}"`,
      '',
    ].join('\n'),
    'utf8',
  )
})

afterAll(async () => {
  await gh.stop()
  await fakeJira?.stop()
  await rm(root, { recursive: true, force: true })
})

async function mirrored(): Promise<string[]> {
  try {
    // `.gitkeep` is scaffolding, not a mirrored issue.
    return (await readdir(join(root, 'issues'))).filter((n) => n.endsWith('.md')).sort()
  } catch {
    return []
  }
}

describe('TC-E-INTAKE — mirroring the external source', () => {
  it('TC-E-INTAKE-01 mgmt pull github writes nothing', async () => {
    const o = io()
    expect(await run(['pull', 'github'], o)).toBe(EXIT.ok)

    expect(o.stdout.join('\n')).toContain('would mirror')
    expect(await mirrored()).toEqual([])
  })

  it('TC-E-INTAKE-02 mgmt pull github --apply mirrors every issue', async () => {
    expect(await run(['pull', 'github', '--apply'], io())).toBe(EXIT.ok)

    expect(await mirrored()).toEqual([
      'acme__app__1.md',
      'acme__app__2.md',
      'acme__app__3.md',
    ])

    const first = await readFile(join(root, 'issues', 'acme__app__1.md'), 'utf8')
    expect(first).toContain('"number": 1')
    expect(first).toContain('"source": "acme/app"')
    expect(first).toContain('alice')
    expect(first).toContain('Login fails on Safari')
  })

  it('TC-E-INTAKE-03 a pull request is not mirrored', async () => {
    // #4 is a PR. The issues endpoint returns it, and nothing downstream would
    // notice it is not a ticket.
    expect(await mirrored()).not.toContain('acme__app__4.md')
  })

  it('TC-E-INTAKE-04 paging is followed to the end', async () => {
    // Three issues at two per page is three requests: two pages of results and
    // the follow of the last `rel="next"`. Mirroring all three is only possible
    // if the Link header was followed.
    const pages = gh.requests.filter((r) => r.path.includes('page=')).length
    expect(pages).toBeGreaterThan(0)
    expect(await mirrored()).toHaveLength(3)
  })

  it('TC-E-INTAKE-05 an incremental pull asks only for what changed', async () => {
    gh.edit(REPO, 2, { title: 'Add CSV and XLSX export', updatedAt: '2026-08-05T10:00:00Z' })

    const o = io()
    expect(await run(['pull', 'github', '--apply'], o)).toBe(EXIT.ok)

    expect(lastSourceRequest()).toContain('since=')
    const second = await readFile(join(root, 'issues', 'acme__app__2.md'), 'utf8')
    expect(second).toContain('Add CSV and XLSX export')
  })

  it('TC-E-INTAKE-06 --full ignores the cursor', async () => {
    expect(await run(['pull', 'github', '--full', '--apply'], io())).toBe(EXIT.ok)
    expect(lastSourceRequest()).not.toContain('since=')
  })
})

describe('TC-E-INTAKE — promotion', () => {
  it('TC-E-INTAKE-07 mgmt promote writes nothing without --apply', async () => {
    const o = io()
    expect(await run(['promote', 'issues/acme__app__1.md'], o)).toBe(EXIT.ok)

    expect(o.stdout.join('\n')).toContain('would create LOCAL-0001')
    await expect(ticketFile('LOCAL-0001')).rejects.toThrow()
  })

  it('TC-E-INTAKE-08 mgmt promote --apply creates a local ticket', async () => {
    const before = await readFile(join(root, 'issues', 'acme__app__1.md'), 'utf8')

    expect(await run(['promote', 'issues/acme__app__1.md', '--apply'], io())).toBe(EXIT.ok)

    const ticket = await ticketFile('LOCAL-0001')
    expect(ticket).toContain('id: "LOCAL-0001"')
    expect(ticket).toContain('Login fails on Safari')
    expect(ticket).toContain('repo: "acme/app"')
    expect(ticket).toContain('number: 1')

    // The mirror is a copy of someone else's record; promotion must not edit it.
    const after = await readFile(join(root, 'issues', 'acme__app__1.md'), 'utf8')
    expect(after).toBe(before)
  })

  it('TC-E-INTAKE-09 promoting the same issue twice is refused', async () => {
    const o = io()
    expect(await run(['promote', 'issues/acme__app__1.md', '--apply'], o)).toBe(EXIT.error)

    expect(o.stderr.join('\n')).toContain('already promoted as LOCAL-0001')
    await expect(ticketFile('LOCAL-0002')).rejects.toThrow()
  })

  it('TC-E-INTAKE-09b --force promotes it again, deliberately', async () => {
    expect(
      await run(['promote', 'issues/acme__app__1.md', '--apply', '--force'], io()),
    ).toBe(EXIT.ok)
    expect(await ticketFile('LOCAL-0002')).toContain('number: 1')

    // Not left behind for the sync cases, which would otherwise push a knowing
    // duplicate into the tracker.
    await rm(join(root, 'tickets', 'LOCAL-0002.md'))
  })
})

describe('TC-E-INTAKE — reaching the tracker', () => {
  let key = ''

  it('TC-E-INTAKE-10 a promoted ticket is created in the tracker on sync', async () => {
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)

    const ticket = await ticketFile('LOCAL-0001')
    const match = ticket.match(/key: "([A-Z][A-Z0-9]*-\d+)"/)
    expect(match, 'the local file records no tracker key').not.toBeNull()
    key = match![1]!

    const remote = await tracker().fetchOne(key)
    expect(remote?.fields.title).toBe('Login fails on Safari')

    // Both links, side by side. Losing either one strands the ticket: without
    // the key it is pushed again as a duplicate, without the source nobody can
    // tell where it came from.
    expect(ticket).toContain('repo: "acme/app"')
  })

  it('TC-E-INTAKE-11 the source link survives a later sync', async () => {
    const o = io()
    expect(await run(['sync', '--apply'], o), o.stdout.join('\n')).toBe(EXIT.ok)

    const ticket = await ticketFile('LOCAL-0001')
    expect(ticket).toContain('repo: "acme/app"')
    expect(ticket).toContain(`key: "${key}"`)
    expect(ticket).not.toContain('conflict: true')
  })
})

describe('TC-E-INTAKE — the read-only guarantee', () => {
  it('TC-E-INTAKE-12 the whole scenario wrote nothing to the source', () => {
    expect(gh.requests.length).toBeGreaterThan(0)

    const writes = gh.requests.filter((r) => r.method !== 'GET')
    expect(writes, `non-GET requests reached the source: ${JSON.stringify(writes)}`).toEqual([])
    expect(gh.wroteNothing()).toBe(true)
  })
})
