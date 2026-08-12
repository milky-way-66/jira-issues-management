/**
 * TC-E-FLOW — docs/testcase/e2e/TC-E-sync-flow.md
 *
 * One continuous scenario: each step depends on the previous one, so they run
 * in order inside a single file with shared state.
 *
 * Writes are detected through `git status --porcelain` rather than by
 * inspecting individual files. That catches a write *anywhere* in the
 * workspace, including `.sync/` — which is exactly where an accidental write
 * would be least visible and most damaging.
 */

import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { FakeJira } from '../support/fake-jira.js'

const exec = promisify(execFile)

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

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-C', root, ...args])
  return stdout
}

/** Empty means the run wrote nothing anywhere in the workspace. */
async function dirty(): Promise<string> {
  return (await git('status', '--porcelain')).trim()
}

async function commitAll(message: string): Promise<void> {
  if ((await dirty()) === '') return // a clean tree is the expected case, not an error
  await git('add', '-A')
  await git('commit', '-q', '-m', message)
}

async function ticketFile(id: string): Promise<string> {
  return readFile(join(root, 'tickets', `${id}.md`), 'utf8')
}

async function writeConfig(): Promise<void> {
  await writeFile(
    join(root, 'config.yml'),
    [
      'mgmt:',
      '  schema_version: 1',
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-flow-'))
  jira = new FakeJira()
  baseUrl = await jira.start()

  await run(['init'], io())
  await writeConfig()

  await git('init', '-q', '-b', 'main')
  await git('config', 'user.email', 'test@example.test')
  await git('config', 'user.name', 'Test')
  await commitAll('scaffold')
})

afterAll(async () => {
  await jira.stop()
  await rm(root, { recursive: true, force: true })
})

describe('TC-E-FLOW — the sync scenario', () => {
  it('TC-E-FLOW-03 mgmt sync writes nothing', async () => {
    jira.seed({ summary: 'First issue', status: 'To Do' })
    jira.seed({ summary: 'Second issue', status: 'To Do' })
    jira.seed({ summary: 'Third issue', status: 'In Progress' })

    const o = io()
    expect(await run(['sync'], o)).toBe(EXIT.ok)

    expect(o.stdout.join('\n')).toContain('Dry run')
    expect(await dirty()).toBe('')
  })

  it('TC-E-FLOW-04 mgmt sync --apply materialises the plan', async () => {
    const o = io()
    expect(await run(['sync', '--apply'], o)).toBe(EXIT.ok)

    for (const n of [1, 2, 3]) {
      const content = await ticketFile(`PROJ-${n}`)
      expect(content).toContain(`id: "PROJ-${n}"`)
      await expect(
        readFile(join(root, '.sync/base', `PROJ-${n}.json`), 'utf8'),
      ).resolves.toContain('PROJ-')
    }

    expect(await dirty()).not.toBe('')
    await commitAll('first sync')
  })

  it('TC-E-FLOW-08 an idle sync is a no-op', async () => {
    // Run before the conflict steps dirty the workspace. This is the property
    // that makes a scheduled run safe: without it, cron commits every interval
    // forever.
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
    expect(await dirty()).toBe('')
  })

  it('TC-E-FLOW-05 a two-sided edit produces exactly one conflict', async () => {
    // PROJ-1: the title changes on both sides, differently.
    const local = await ticketFile('PROJ-1')
    await writeFile(
      join(root, 'tickets/PROJ-1.md'),
      local.replace('title: "First issue"', 'title: "Renamed locally"'),
      'utf8',
    )
    jira.edit('PROJ-1', { summary: 'Renamed remotely' })

    // PROJ-2: local only. It must sync normally despite its neighbour.
    const second = await ticketFile('PROJ-2')
    await writeFile(
      join(root, 'tickets/PROJ-2.md'),
      second.replace(/\n\n$/, '\n') + '\nLocal note.\n',
      'utf8',
    )

    const o = io()
    expect(await run(['sync', '--apply'], o)).toBe(EXIT.conflicts)

    expect(await ticketFile('PROJ-1')).toContain('conflict: true')
    expect(o.stdout.join('\n')).toContain('CONFLICT title')

    // The undisputed ticket went through.
    expect(jira.get('PROJ-2')?.fields['description']).toContain('Local note.')

    await commitAll('conflict recorded')
  })

  it('TC-E-FLOW-06 a conflicted ticket is skipped by later runs', async () => {
    const before = await ticketFile('PROJ-1')

    // Even though the tracker changed again, the file must not be rewritten
    // around a human's in-progress edit.
    jira.edit('PROJ-1', { summary: 'Renamed remotely again' })

    const o = io()
    expect(await run(['sync', '--apply'], o)).toBe(EXIT.ok)
    expect(await ticketFile('PROJ-1')).toBe(before)
  })

  it('TC-E-FLOW-07 resolve --take local clears the conflict', async () => {
    const preview = io()
    expect(await run(['resolve', 'PROJ-1', '--take', 'local'], preview)).toBe(EXIT.ok)
    expect(preview.stdout.join('\n')).toContain('taking local')

    expect(await run(['resolve', 'PROJ-1', '--take', 'local', '--apply'], io())).toBe(EXIT.ok)

    const resolved = await ticketFile('PROJ-1')
    expect(resolved).toContain('conflict: false')
    expect(resolved).toContain('Renamed locally')

    // The decision reaches the tracker on the next sync, and nothing conflicts.
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
    expect(jira.get('PROJ-1')?.fields['summary']).toBe('Renamed locally')

    // A sync that pushes makes the tracker newer, so the following run legitimately
    // advances the cursor once. It settles after that, and stays settled — which
    // is what TC-E-FLOW-11 goes on to assert across twenty runs.
    await commitAll('resolved')
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
    await commitAll('cursor settled')

    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
    expect(await dirty()).toBe('')
  })
})

describe('TC-E-FLOW — promotion', () => {
  it('TC-E-FLOW-09 promote creates a tracker issue and links both sides', async () => {
    await writeFile(
      join(root, 'issues/acme__app__42.md'),
      [
        '---',
        'source: "acme/app"',
        'number: 42',
        'title: "Login fails after password reset"',
        'state: "open"',
        'author: "alice"',
        'labels: []',
        'created: "2026-08-01T00:00:00Z"',
        'updated: "2026-08-11T00:00:00Z"',
        '---',
        '',
        'Steps to reproduce...',
        '',
      ].join('\n'),
      'utf8',
    )

    const preview = io()
    expect(await run(['promote', 'issues/acme__app__42.md'], preview)).toBe(EXIT.ok)
    expect(preview.stdout.join('\n')).toContain('would create LOCAL-0001')

    expect(
      await run(['promote', 'issues/acme__app__42.md', '--type', 'Task', '--apply'], io()),
    ).toBe(EXIT.ok)

    const promoted = await ticketFile('LOCAL-0001')
    expect(promoted).toContain('Login fails after password reset')
    expect(promoted).toContain('number: 42')
    // The mirror's own warning banner must not travel into the ticket body.
    expect(promoted).not.toContain('Mirror of an external issue')

    const before = jira.requests.filter((r) => r.method === 'POST').length
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)

    const creates = jira.requests.filter(
      (r) => r.method === 'POST' && r.path === '/rest/api/2/issue',
    )
    expect(creates).toHaveLength(1)
    expect(before).toBe(0)

    const payload = creates[0]?.body as { fields: { labels: string[] } }
    expect(payload.fields.labels).toContain('sync-LOCAL-0001')

    expect(await ticketFile('LOCAL-0001')).toMatch(/key: "PROJ-\d+"/)
    await commitAll('promoted')
  })

  it('TC-E-FLOW-10 an interrupted creation does not duplicate', async () => {
    // The tracker already holds the issue; the local file never got the key,
    // exactly as if the process died between the two.
    jira.seed({ summary: 'Created before the crash', labels: ['sync-LOCAL-0007'] })

    await run(['new', 'Created before the crash', '--apply'], io())
    const created = (await readFile(join(root, 'tickets/LOCAL-0002.md'), 'utf8')).replace(
      'sync-LOCAL-0002',
      'sync-LOCAL-0007',
    )
    await writeFile(join(root, 'tickets/LOCAL-0007.md'), created.replace(/LOCAL-0002/g, 'LOCAL-0007'), 'utf8')
    await rm(join(root, 'tickets/LOCAL-0002.md'))

    const before = jira.requests.filter(
      (r) => r.method === 'POST' && r.path === '/rest/api/2/issue',
    ).length

    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)

    const after = jira.requests.filter(
      (r) => r.method === 'POST' && r.path === '/rest/api/2/issue',
    ).length
    expect(after).toBe(before)

    expect(await readFile(join(root, 'tickets/LOCAL-0007.md'), 'utf8')).toContain('key: "PROJ-')
    await commitAll('adopted')
  })
})

describe('TC-E-FLOW — repetition', () => {
  it('TC-E-FLOW-11 twenty consecutive syncs remain stable', async () => {
    const idsBefore = (await git('ls-files', 'tickets')).trim().split('\n').sort()
    const createsBefore = jira.requests.filter(
      (r) => r.method === 'POST' && r.path === '/rest/api/2/issue',
    ).length

    // The first run may settle residue from the previous step.
    expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
    await commitAll('settle')

    for (let i = 0; i < 20; i++) {
      expect(await run(['sync', '--apply'], io())).toBe(EXIT.ok)
      // This is the scheduled-run failure mode: a per-run drift too small to
      // notice, compounding into a commit every interval forever.
      expect(await dirty()).toBe('')
    }

    expect((await git('ls-files', 'tickets')).trim().split('\n').sort()).toEqual(idsBefore)

    const createsAfter = jira.requests.filter(
      (r) => r.method === 'POST' && r.path === '/rest/api/2/issue',
    ).length
    expect(createsAfter).toBe(createsBefore)
  })
})

describe('TC-E-FLOW — output contract', () => {
  it('TC-E-FLOW-14b sync --json emits parseable output and keeps diagnostics off stdout', async () => {
    jira.edit('PROJ-3', { summary: 'Changed for the json case' })

    const o = io()
    expect(await run(['--json', 'sync'], o)).toBe(EXIT.ok)

    const parsed = JSON.parse(o.stdout.join('\n')) as {
      tickets: { id: string; pull: unknown[] }[]
      withheld: number
    }
    expect(parsed.tickets.some((t) => t.id === 'PROJ-3')).toBe(true)
    expect(parsed.withheld).toBe(0)
  })

  it('TC-E-SAFE-07 --limit caps the tickets touched and says so', async () => {
    jira.edit('PROJ-1', { summary: 'Bulk change one' })
    jira.edit('PROJ-2', { summary: 'Bulk change two' })
    jira.edit('PROJ-3', { summary: 'Bulk change three' })

    const o = io()
    expect(await run(['sync', '--limit', '1'], o)).toBe(EXIT.ok)

    const out = o.stdout.join('\n')
    // A silent cap reads as "everything is in sync" when it is not.
    expect(out).toContain('withheld by --limit')
  })
})

describe('TC-E-FLOW — status and index', () => {
  it('TC-E-FLOW-12b status resolves the workspace from a subdirectory', async () => {
    const o = io({ cwd: join(root, 'tickets') })
    const code = await run(['status'], o)

    expect([EXIT.ok, EXIT.conflicts]).toContain(code)
    expect(o.stdout.join('\n')).toContain('cursor jira:')
  })

  it('TC-E-FLOW-12c index regenerates a row per ticket', async () => {
    expect(await run(['index'], io())).toBe(EXIT.ok)

    const index = await readFile(join(root, 'INDEX.md'), 'utf8')
    expect(index).toContain('| ID | Type | Status | Title |')
    expect(index).toContain('[PROJ-1](tickets/PROJ-1.md)')
  })

  it('TC-E-SAFE-10b archive moves a closed ticket and keeps it retrievable', async () => {
    jira.seed({ summary: 'Finished work', status: 'To Do' }, 'PROJ-900')
    await run(['sync', '--apply'], io())

    const file = await ticketFile('PROJ-900')
    await writeFile(
      join(root, 'tickets/PROJ-900.md'),
      file.replace('status: "To Do"', 'status: "Done"'),
      'utf8',
    )

    const preview = io()
    expect(await run(['archive'], preview)).toBe(EXIT.ok)
    expect(preview.stdout.join('\n')).toContain('would archive PROJ-900')
    expect(preview.stdout.join('\n')).toContain('nothing is deleted')

    expect(await run(['archive', '--apply'], io())).toBe(EXIT.ok)

    await expect(ticketFile('PROJ-900')).rejects.toThrow()
    await expect(
      readFile(join(root, 'archive/PROJ-900.md'), 'utf8'),
    ).resolves.toContain('Finished work')
  })
})
