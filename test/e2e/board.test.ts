/**
 * TC-E-BOARD — docs/testcase/e2e/TC-E-board.md
 *
 * The command end to end, in a real scaffolded workspace. The tracker is the
 * in-process substitute and is only involved where identity is.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { FakeJira } from '../support/fake-jira.js'

let root: string
let jira: FakeJira
let jiraUrl: string

function io(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l), cwd: root, env: {} }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(join(root, path))
    return true
  } catch {
    return false
  }
}

/** Writes a ticket file directly: the board reads the workspace, not the tracker. */
async function ticket(
  id: string,
  fields: { status?: string; assignee?: string | null; type?: string; title?: string } = {},
): Promise<void> {
  const body = [
    '---',
    `id: "${id}"`,
    `title: "${fields.title ?? `Title of ${id}`}"`,
    `status: "${fields.status ?? 'To Do'}"`,
    fields.assignee ? `assignee: "${fields.assignee}"` : 'assignee: null',
    `type: "${fields.type ?? 'Task'}"`,
    'parent: null',
    'labels: []',
    'priority: null',
    'estimate: null',
    'due: null',
    'jira:',
    `  key: "${id}"`,
    '  url: ""',
    '  updated: "2026-08-12T00:00:00.000+0000"',
    'sync:',
    '  base: "2026-08-12T00:00:00.000+0000"',
    '  last_pull: "2026-08-12T00:00:00.000Z"',
    '  last_push: null',
    '  conflict: false',
    '---',
    '',
    `Body of ${id}.`,
    '',
  ].join('\n')

  await writeFile(join(root, 'tickets', `${id}.md`), body, 'utf8')
}

async function setUpWorkspace(env: string[]): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'mgmt-board-'))
  await run(['init'], io())

  await writeFile(
    join(root, 'config.yml'),
    [
      'mgmt:',
      '  schema_version: 1',
      '  cli_range: ">=0.1.0 <1.0.0"',
      'jira:',
      `  base_url: "${jiraUrl}"`,
      `  project: "${jira.project}"`,
      `  epic_link_field: "${jira.epicLinkField}"`,
      'github:',
      '  repos: []',
      '  base_url: "https://api.github.com"',
      'sync:',
      '  archive_after_days: 30',
      '  scheduled: false',
      '',
    ].join('\n'),
    'utf8',
  )

  await writeFile(join(root, '.env'), env.join('\n') + '\n', 'utf8')

  await ticket('PROJ-1', { assignee: 'alice' })
  await ticket('PROJ-2', { status: 'In Progress', assignee: 'bob' })
  await ticket('PROJ-3', { status: 'Done' })
}

beforeAll(async () => {
  jira = new FakeJira({ me: 'alice' })
  jiraUrl = await jira.start()
})

afterAll(async () => {
  await jira.stop()
  await rm(root, { recursive: true, force: true })
})

describe('with no credentials', () => {
  beforeEach(async () => {
    // No JIRA_PAT at all: the board must be entirely local.
    await setUpWorkspace([])
  })

  it('TC-E-BOARD-01 writes board.html and exits 0', async () => {
    const out = io()

    expect(await run(['board'], out)).toBe(EXIT.ok)
    expect(await exists('board.html')).toBe(true)
    expect(out.stdout.join('\n')).toContain('board.html')
  })

  it('TC-E-BOARD-02 includes every ticket in the working set', async () => {
    await run(['board'], io())
    const html = await readFile(join(root, 'board.html'), 'utf8')

    for (const id of ['PROJ-1', 'PROJ-2', 'PROJ-3']) expect(html).toContain(id)
    expect(html).toContain('To Do')
    expect(html).toContain('In Progress')
    expect(html).toContain('Done')
  })

  it('TC-E-BOARD-03 writes elsewhere with --out', async () => {
    expect(await run(['board', '--out', 'docs/board.html'], io())).toBe(EXIT.ok)

    expect(await exists('docs/board.html')).toBe(true)
    expect(await exists('board.html')).toBe(false)
  })

  it('TC-E-BOARD-04 emits the model with --json and writes no file', async () => {
    const out = io()

    expect(await run(['--json', 'board'], out)).toBe(EXIT.ok)

    const board = JSON.parse(out.stdout.join('\n')) as {
      project: { total: number }
      mine: { total: number }
      columns: string[]
    }
    expect(board.columns).toEqual(['To Do', 'In Progress', 'Done'])
    expect(board.project.total).toBe(3)
    expect(await exists('board.html')).toBe(false)
  })

  it('TC-E-BOARD-05 filters the personal board with --me', async () => {
    const out = io()

    expect(await run(['--json', 'board', '--me', 'bob'], out)).toBe(EXIT.ok)

    const board = JSON.parse(out.stdout.join('\n')) as {
      mine: { columns: { cards: { id: string }[] }[] }
    }
    expect(board.mine.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual(['PROJ-2'])
  })

  it('TC-E-BOARD-06 still produces a board with no credentials', async () => {
    const out = io()

    expect(await run(['board'], out)).toBe(EXIT.ok)

    const text = out.stdout.join('\n')
    expect(text).toContain('3 tickets')
    expect(text).toMatch(/could not tell who you are/)
    // The tracker was never contacted — there was no token to contact it with.
    expect(jira.requests.filter((r) => r.path === '/rest/api/2/myself')).toHaveLength(0)
  })

  it('TC-E-BOARD-07 skips an unreadable ticket rather than failing', async () => {
    await writeFile(join(root, 'tickets', 'PROJ-9.md'), 'not a ticket at all', 'utf8')
    const out = io()

    expect(await run(['board'], out)).toBe(EXIT.ok)

    const html = await readFile(join(root, 'board.html'), 'utf8')
    expect(html).toContain('PROJ-1')
    expect(out.stderr.join('\n')).toContain('PROJ-9')
  })

  it('TC-E-BOARD-08 orders the columns with --columns', async () => {
    const out = io()

    await run(['--json', 'board', '--columns', 'Done,In Progress,To Do'], out)

    const board = JSON.parse(out.stdout.join('\n')) as { columns: string[] }
    expect(board.columns).toEqual(['Done', 'In Progress', 'To Do'])
  })

  it('TC-E-BOARD-09 ignores the generated board and the identity cache', async () => {
    const ignored = await readFile(join(root, '.gitignore'), 'utf8')

    expect(ignored).toMatch(/^board\.html$/m)
    expect(ignored).toMatch(/^\.sync\/identity\.json$/m)
  })
})

describe('with a reachable tracker', () => {
  it('TC-E-BOARD-10 resolves the identity once and caches it', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`])
    const before = jira.requests.filter((r) => r.path === '/rest/api/2/myself').length

    const first = io()
    expect(await run(['--json', 'board'], first)).toBe(EXIT.ok)
    const second = io()
    expect(await run(['--json', 'board'], second)).toBe(EXIT.ok)

    const asked = jira.requests.filter((r) => r.path === '/rest/api/2/myself').length - before
    expect(asked).toBe(1)

    for (const out of [first, second]) {
      const board = JSON.parse(out.stdout.join('\n')) as {
        me: string
        mine: { columns: { cards: { id: string }[] }[] }
      }
      expect(board.me).toBe('alice')
      expect(board.mine.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual(['PROJ-1'])
    }
  })

  it('TC-E-BOARD-11 previews a move without writing', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`])
    jira.seed({ summary: 'Title of PROJ-1', status: 'To Do' }, 'PROJ-1')
    const before = jira.requests.length
    const out = io()

    expect(await run(['move', 'PROJ-1', 'Done'], out)).toBe(EXIT.ok)

    expect(out.stdout.join('\n')).toContain('would move PROJ-1  To Do → Done')
    expect(jira.requests.slice(before).filter((r) => r.method !== 'GET')).toHaveLength(0)
  })

  it('TC-E-BOARD-12 transitions the ticket and brings the file into line', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`])
    jira.seed({ summary: 'Title of PROJ-1', status: 'To Do' }, 'PROJ-1')
    const out = io()

    expect(await run(['move', 'PROJ-1', 'In Progress', '--apply'], out)).toBe(EXIT.ok)

    expect(out.stdout.join('\n')).toContain('PROJ-1  To Do → In Progress')
    expect(await readFile(join(root, 'tickets', 'PROJ-1.md'), 'utf8')).toContain(
      'status: "In Progress"',
    )
  })

  it('TC-E-BOARD-13 refuses a status the workflow does not offer', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`])
    jira.seed({ summary: 'Title of PROJ-1', status: 'To Do' }, 'PROJ-1')
    const out = io()

    expect(await run(['move', 'PROJ-1', 'Shipped', '--apply'], out)).toBe(EXIT.error)

    // The tracker's own message names what the workflow does allow.
    expect(out.stderr.join('\n')).toMatch(/no transition to "Shipped"/)
    expect(out.stderr.join('\n')).toMatch(/Available:/)
  })

  it('TC-E-BOARD-14 refuses to serve an applying board with no token', async () => {
    await setUpWorkspace([])
    const out = io()

    expect(await run(['board', '--serve', '--apply'], out)).toBe(EXIT.error)
    expect(out.stderr.join('\n')).toContain('JIRA_PAT')
  })

  it('TC-E-BOARD-10b lets MGMT_ME in .env override the tracker', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`, 'MGMT_ME=bob'])
    const before = jira.requests.filter((r) => r.path === '/rest/api/2/myself').length
    const out = io()

    expect(await run(['--json', 'board'], out)).toBe(EXIT.ok)

    const board = JSON.parse(out.stdout.join('\n')) as { me: string }
    expect(board.me).toBe('bob')
    expect(jira.requests.filter((r) => r.path === '/rest/api/2/myself').length).toBe(before)
  })
})
