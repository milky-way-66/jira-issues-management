/**
 * TC-E-BOARD — docs/testcase/e2e/TC-E-board.md
 *
 * The command end to end, in a real scaffolded workspace. The tracker is the
 * in-process substitute and is only involved where identity is.
 */

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
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

/**
 * Runs `mgmt board`, which serves until told to stop, and hands the running
 * URL to `visit`. `hold` is the seam: the command waits on it instead of on the
 * interrupt a person would type.
 */
async function serving(
  argv: string[],
  visit: (url: string) => Promise<void>,
): Promise<Io & { stdout: string[]; stderr: string[]; code: number }> {
  const out = io()
  const code = await run(argv, { ...out, hold: visit })
  return Object.assign(out, { code })
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

  it('TC-E-BOARD-01 serves the board on loopback and exits 0 when stopped', async () => {
    let served = ''
    const out = await serving(['board'], async (url) => {
      served = url
      expect((await fetch(url)).status).toBe(200)
    })

    expect(out.code).toBe(EXIT.ok)
    expect(served).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(out.stdout.join('\n')).toContain(served)
  })

  it('TC-E-BOARD-02 includes every ticket in the working set', async () => {
    await serving(['board'], async (url) => {
      const html = await (await fetch(url)).text()

      for (const id of ['PROJ-1', 'PROJ-2', 'PROJ-3']) expect(html).toContain(id)
      expect(html).toContain('To Do')
      expect(html).toContain('In Progress')
      expect(html).toContain('Done')
    })
  })

  it('TC-E-BOARD-03 listens on the port it was given', async () => {
    const out = await serving(['board', '--port', '8931'], async (url) => {
      expect(url).toBe('http://127.0.0.1:8931')
      expect((await fetch(url)).status).toBe(200)
    })

    expect(out.code).toBe(EXIT.ok)
  })

  it('TC-E-BOARD-03b shows an edit made while it is running', async () => {
    await serving(['board'], async (url) => {
      expect(await (await fetch(url)).text()).not.toContain('Written after the server started')

      await ticket('PROJ-4', { title: 'Written after the server started' })

      expect(await (await fetch(url)).text()).toContain('Written after the server started')
    })
  })

  it('TC-E-BOARD-04 emits the model with --json and serves nothing', async () => {
    const out = io()

    // No `hold`: --json must return on its own rather than start a server.
    expect(await run(['--json', 'board'], out)).toBe(EXIT.ok)

    const board = JSON.parse(out.stdout.join('\n')) as {
      project: { total: number }
      mine: { total: number }
      columns: string[]
    }
    expect(board.columns).toEqual(['To Do', 'In Progress', 'Done'])
    expect(board.project.total).toBe(3)
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
    const out = await serving(['board'], async (url) => {
      expect(await (await fetch(url)).text()).toContain('PROJ-1')
    })

    expect(out.code).toBe(EXIT.ok)
    const text = out.stdout.join('\n')
    expect(text).toContain('3 tickets')
    expect(text).toMatch(/could not tell who you are/)
    // The tracker was never contacted — there was no token to contact it with.
    expect(jira.requests.filter((r) => r.path === '/rest/api/2/myself')).toHaveLength(0)
  })

  it('TC-E-BOARD-07 skips an unreadable ticket rather than failing', async () => {
    await writeFile(join(root, 'tickets', 'PROJ-9.md'), 'not a ticket at all', 'utf8')

    const out = await serving(['board'], async (url) => {
      expect(await (await fetch(url)).text()).toContain('PROJ-1')
    })

    expect(out.code).toBe(EXIT.ok)
    expect(out.stderr.join('\n')).toContain('PROJ-9')
  })

  it('TC-E-BOARD-08 orders the columns with --columns', async () => {
    const out = io()

    await run(['--json', 'board', '--columns', 'Done,In Progress,To Do'], out)

    const board = JSON.parse(out.stdout.join('\n')) as { columns: string[] }
    expect(board.columns).toEqual(['Done', 'In Progress', 'To Do'])
  })

  it('TC-E-BOARD-09 writes nothing into the workspace', async () => {
    const before = (await readdir(root)).sort()

    await serving(['board'], async (url) => {
      await fetch(url)
    })

    expect((await readdir(root)).sort()).toEqual(before)
    // The identity file is the one thing a board may add, and it is ignored.
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toMatch(
      /^\.sync\/identity\.json$/m,
    )
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

    expect(await run(['board', '--apply'], out)).toBe(EXIT.error)
    expect(out.stderr.join('\n')).toContain('JIRA_PAT')
  })

  it('TC-E-BOARD-15 lets a drag move a ticket end to end', async () => {
    await setUpWorkspace([`JIRA_PAT=${jira.token}`])
    jira.seed({ summary: 'Title of PROJ-1', status: 'To Do' }, 'PROJ-1')

    await serving(['board', '--apply'], async (url) => {
      const page = await (await fetch(url)).text()
      const nonce = /data-nonce="([^"]+)"/.exec(page)?.[1] ?? ''
      expect(nonce).not.toBe('')

      const res = await fetch(`${url}/api/move`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mgmt-nonce': nonce },
        body: JSON.stringify({ id: 'PROJ-1', to: 'In Progress' }),
      })

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ to: 'In Progress', applied: true })
    })

    expect(await readFile(join(root, 'tickets', 'PROJ-1.md'), 'utf8')).toContain(
      'status: "In Progress"',
    )
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
