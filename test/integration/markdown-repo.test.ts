/**
 * TC-I-REPO — docs/testcase/integration/TC-I-markdown-repo.md
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MarkdownTicketRepo,
  TicketFormatError,
  parseTicket,
  serialiseTicket,
} from '../../src/adapters/markdown-repo.js'
import type { RemoteTicket, Ticket } from '../../src/core/ticket.js'

let root: string
let repo: MarkdownTicketRepo

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-repo-'))
  repo = new MarkdownTicketRepo(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'PROJ-123',
    fields: {
      title: 'Review monitoring documentation',
      body: '## Description\n\nSome text.',
      status: 'In Progress',
      assignee: 'alice',
      type: 'Task',
      parent: 'PROJ-100',
      labels: ['docs-qa', 'monitoring'],
      priority: 'Medium',
      estimate: '4h',
      due: '2026-08-20',
      ...over.fields,
    },
    jira: {
      key: 'PROJ-123',
      url: 'https://jira.example.com/browse/PROJ-123',
      updated: '2026-08-11T09:00:00+09:00',
    },
    sync: { base: 'abc123', lastPull: null, lastPush: null, conflict: false },
    ...over,
  }
}

describe('TC-I-REPO — round trip', () => {
  it('TC-I-REPO-01 save then load reproduces the ticket', async () => {
    const original = ticket()
    await repo.save(original)
    expect(await repo.load('PROJ-123')).toEqual(original)
  })

  it('TC-I-REPO-02 saving an unmodified ticket is byte-stable', async () => {
    await repo.save(ticket())
    const first = await readFile(join(root, 'tickets/PROJ-123.md'), 'utf8')

    const loaded = await repo.load('PROJ-123')
    if (!loaded) throw new Error('expected a ticket')
    await repo.save(loaded)

    expect(await readFile(join(root, 'tickets/PROJ-123.md'), 'utf8')).toBe(first)
  })

  it('TC-I-REPO-03 frontmatter key order does not depend on insertion order', () => {
    const a = ticket()
    const b: Ticket = {
      sync: a.sync,
      ...(a.jira ? { jira: a.jira } : {}),
      fields: {
        due: a.fields.due,
        title: a.fields.title,
        body: a.fields.body,
        labels: a.fields.labels,
        estimate: a.fields.estimate,
        priority: a.fields.priority,
        parent: a.fields.parent,
        type: a.fields.type,
        assignee: a.fields.assignee,
        status: a.fields.status,
      },
      id: a.id,
    }
    expect(serialiseTicket(b)).toBe(serialiseTicket(a))
  })
})

describe('TC-I-REPO — formatting fidelity', () => {
  it('TC-I-REPO-04 non-Latin text survives unescaped', async () => {
    const t = ticket({
      fields: { ...ticket().fields, title: '【監視】通知設定の見直し', body: '本文テキスト。\n\n詳細：あり' },
    })
    await repo.save(t)

    const raw = await readFile(join(root, 'tickets/PROJ-123.md'), 'utf8')
    expect(raw).toContain('【監視】通知設定の見直し')
    expect(raw).not.toMatch(/\\u[0-9a-f]{4}/i)
    expect(await repo.load('PROJ-123')).toEqual(t)
  })

  it('TC-I-REPO-05 a title with colon, brackets and quotes round-trips', async () => {
    const title = '[QA] Review: "monitoring" — {edge} case'
    const t = ticket({ fields: { ...ticket().fields, title } })
    await repo.save(t)
    expect((await repo.load('PROJ-123'))?.fields.title).toBe(title)
  })

  it('TC-I-REPO-06 a body containing --- is not read as a delimiter', async () => {
    const body = 'Intro.\n\n---\n\nAfter a horizontal rule.\n\n---'
    const t = ticket({ fields: { ...ticket().fields, body } })
    await repo.save(t)
    expect((await repo.load('PROJ-123'))?.fields.body).toBe(body)
  })

  it('TC-I-REPO-07 a body containing conflict markers round-trips', async () => {
    const body = [
      '<<<<<<< LOCAL',
      'status: In Progress',
      '=======',
      'status: In Review',
      '>>>>>>> JIRA',
    ].join('\n')
    const t = ticket({ fields: { ...ticket().fields, body } })
    await repo.save(t)
    expect((await repo.load('PROJ-123'))?.fields.body).toBe(body)
  })
})

describe('TC-I-REPO — validation', () => {
  it('TC-I-REPO-08 a missing required field names the file and the field', async () => {
    await mkdir(join(root, 'tickets'), { recursive: true })
    await writeFile(join(root, 'tickets/BROKEN-1.md'), '---\nid: BROKEN-1\n---\n\nBody\n')

    await expect(repo.load('BROKEN-1')).rejects.toThrow(TicketFormatError)
    await expect(repo.load('BROKEN-1')).rejects.toThrow(/title/)
    await expect(repo.load('BROKEN-1')).rejects.toThrow(/BROKEN-1\.md/)
  })

  it('TC-I-REPO-09 an unknown status value loads without complaint', async () => {
    const t = ticket({ fields: { ...ticket().fields, status: 'Pending Client Review' } })
    await repo.save(t)
    expect((await repo.load('PROJ-123'))?.fields.status).toBe('Pending Client Review')
  })

  it('TC-I-REPO-10 one malformed file does not prevent others loading', async () => {
    await repo.save(ticket())
    await repo.save(ticket({ id: 'PROJ-124' }))
    await writeFile(join(root, 'tickets/PROJ-999.md'), 'not a ticket at all')

    expect(await repo.list()).toEqual(['PROJ-123', 'PROJ-124', 'PROJ-999'])
    expect(await repo.load('PROJ-123')).not.toBeNull()
    expect(await repo.load('PROJ-124')).not.toBeNull()
    await expect(repo.load('PROJ-999')).rejects.toThrow(TicketFormatError)
  })

  it('TC-I-REPO-10b unterminated frontmatter is rejected', () => {
    expect(() => parseTicket('x.md', '---\nid: A\ntitle: T\n')).toThrow(/unterminated/)
  })

  it('TC-I-REPO-10c invalid YAML is rejected with the parser message', () => {
    expect(() => parseTicket('x.md', '---\nid: "unclosed\n---\n\nbody\n')).toThrow(/invalid YAML/)
  })
})

describe('TC-I-REPO — listing', () => {
  it('TC-I-REPO-11 listing is sorted deterministically', async () => {
    for (const id of ['PROJ-3', 'PROJ-1', 'PROJ-2']) await repo.save(ticket({ id }))
    expect(await repo.list()).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3'])
  })

  it('TC-I-REPO-12 non-ticket files are ignored', async () => {
    await repo.save(ticket())
    await writeFile(join(root, 'tickets/README.txt'), 'notes')
    await writeFile(join(root, 'tickets/.DS_Store'), '')
    expect(await repo.list()).toEqual(['PROJ-123'])
  })

  it('TC-I-REPO-13 archived tickets are excluded from listing', async () => {
    await repo.save(ticket())
    await repo.save(ticket({ id: 'PROJ-124' }))
    await repo.archive('PROJ-124')
    expect(await repo.list()).toEqual(['PROJ-123'])
  })

  it('TC-I-REPO-13b listing an empty workspace returns nothing', async () => {
    expect(await repo.list()).toEqual([])
  })
})

describe('TC-I-REPO — base snapshots and cursors', () => {
  const snapshot: RemoteTicket = {
    key: 'PROJ-123',
    updated: '2026-08-11T09:00:00+09:00',
    fields: {
      title: 'T',
      body: 'B',
      status: 'To Do',
      assignee: null,
      type: 'Task',
      parent: null,
      labels: [],
      priority: null,
      estimate: null,
      due: null,
    },
  }

  it('TC-I-REPO-14 a base snapshot round-trips', async () => {
    await repo.writeBase('PROJ-123', snapshot)
    expect(await repo.readBase('PROJ-123')).toEqual(snapshot)
  })

  it('TC-I-REPO-15 a missing snapshot returns null rather than throwing', async () => {
    expect(await repo.readBase('PROJ-999')).toBeNull()
  })

  it('TC-I-REPO-16 cursors persist across repository instances', async () => {
    await repo.setCursor('jira', '2026-08-11T09:00:00+09:00')
    await repo.setCursor('github', '2026-08-10T00:00:00+09:00')

    const reopened = new MarkdownTicketRepo(root)
    expect(await reopened.getCursor('jira')).toBe('2026-08-11T09:00:00+09:00')
    expect(await reopened.getCursor('github')).toBe('2026-08-10T00:00:00+09:00')
    expect(await reopened.getCursor('absent')).toBeNull()
  })

  it('TC-I-REPO-17 snapshot writes leave no partial file behind', async () => {
    await repo.writeBase('PROJ-123', snapshot)
    const updated = { ...snapshot, updated: '2026-08-12T00:00:00+09:00' }
    await repo.writeBase('PROJ-123', updated)

    expect(await repo.readBase('PROJ-123')).toEqual(updated)

    const { readdir } = await import('node:fs/promises')
    const files = await readdir(join(root, '.sync/base'))
    expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
})

describe('TC-I-REPO — archive', () => {
  it('TC-I-REPO-18 archiving moves the file and keeps the content', async () => {
    const t = ticket()
    await repo.save(t)
    await repo.archive('PROJ-123')

    expect(await repo.load('PROJ-123')).toBeNull()
    const archived = await readFile(join(root, 'archive/PROJ-123.md'), 'utf8')
    expect(archived).toContain('Review monitoring documentation')
  })

  it('TC-I-REPO-19 archiving preserves the base snapshot alongside', async () => {
    await repo.save(ticket())
    await repo.writeBase('PROJ-123', {
      key: 'PROJ-123',
      updated: '2026-08-11T09:00:00+09:00',
      fields: ticket().fields,
    })
    await repo.archive('PROJ-123')

    const kept = await readFile(join(root, '.sync/archive/PROJ-123.json'), 'utf8')
    expect(JSON.parse(kept).key).toBe('PROJ-123')
  })

  it('TC-I-REPO-19b archiving a ticket that never synced still works', async () => {
    await repo.save(ticket({ id: 'LOCAL-0001' }))
    await expect(repo.archive('LOCAL-0001')).resolves.toBeUndefined()
  })
})

describe('TC-I-REPO — local ids', () => {
  it('TC-I-REPO-20 the next id follows the highest, including archived', async () => {
    await repo.save(ticket({ id: 'LOCAL-0003' }))
    await repo.save(ticket({ id: 'LOCAL-0007' }))
    await repo.archive('LOCAL-0007')
    await repo.save(ticket({ id: 'PROJ-500' }))

    expect(await repo.highestLocalId()).toBe(7)
  })

  it('TC-I-REPO-20b an empty workspace starts at zero', async () => {
    expect(await repo.highestLocalId()).toBe(0)
  })
})
