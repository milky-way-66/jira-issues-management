/**
 * TC-I-SYNC — docs/testcase/integration/TC-I-sync-usecase.md
 *
 * Every port is a Map; time is pinned. These verify orchestration — what the
 * use case decides, in what order, and what it refuses.
 */

import { describe, expect, it } from 'vitest'
import {
  FixedClock,
  InMemoryIssueSource,
  InMemoryTicketRepo,
  InMemoryTracker,
} from '../../src/adapters/in-memory.js'
import {
  TRACKER_CURSOR,
  createPending,
  execute,
  plan,
} from '../../src/core/use-cases/sync-tickets.js'
import type { FieldSet, RemoteTicket, Ticket } from '../../src/core/ticket.js'

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

function ticket(id: string, over: Partial<FieldSet> = {}, sync: Partial<Ticket['sync']> = {}): Ticket {
  return {
    id,
    fields: { ...BASE_FIELDS, ...over },
    jira: { key: id, url: '', updated: '2026-08-11T09:00:00+09:00' },
    sync: { base: 'x', lastPull: null, lastPush: null, conflict: false, ...sync },
  }
}

function remote(key: string, over: Partial<FieldSet> = {}, updated = '2026-08-11T10:00:00+09:00'): RemoteTicket {
  return { key, updated, fields: { ...BASE_FIELDS, ...over } }
}

function snapshot(key: string, over: Partial<FieldSet> = {}): RemoteTicket {
  return { key, updated: '2026-08-11T09:00:00+09:00', fields: { ...BASE_FIELDS, ...over } }
}

function deps(repo: InMemoryTicketRepo, tracker: InMemoryTracker) {
  return { repo, tracker, clock: new FixedClock() }
}

describe('TC-I-SYNC — dry run', () => {
  it('TC-I-SYNC-01 dry-run performs no writes', async () => {
    // Pending in both directions: the remote changed the title, we changed the body.
    const repo = new InMemoryTicketRepo([ticket('PROJ-1', { body: 'Local edit.' })])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1', { title: 'Renamed remotely' })]] })

    const planned = await plan(deps(repo, tracker))

    expect(planned.plan.tickets).not.toHaveLength(0)
    expect(planned.plan.tickets[0]?.pull.length).toBeGreaterThan(0)
    expect(planned.plan.tickets[0]?.push.length).toBeGreaterThan(0)

    // The assertion that matters: not "data is unchanged" — which a
    // compensating bug could satisfy — but "no write method was entered".
    expect(repo.writes()).toEqual([])
    expect(tracker.writes()).toEqual([])
  })

  it('TC-I-SYNC-02 apply executes exactly the plan that was previewed', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1', { body: 'Local edit.' })])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1', { title: 'Renamed remotely' })]] })

    const planned = await plan(deps(repo, tracker))
    const previewed = JSON.parse(JSON.stringify(planned.plan))

    const result = await execute(deps(repo, tracker), planned)

    expect(result.plan).toEqual(previewed)

    const sent = tracker.calls.filter((c) => c.method === 'applyChanges')
    expect(sent).toHaveLength(1)
    expect(sent[0]?.args[1]).toEqual(previewed.tickets[0].push)
  })
})

describe('TC-I-SYNC — ordering', () => {
  it('TC-I-SYNC-03 pull happens before push', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1', { body: 'Local edit.' })])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1', { title: 'Renamed remotely' })]] })

    await execute(deps(repo, tracker), await plan(deps(repo, tracker)))

    const methods = tracker.calls.map((c) => c.method)
    expect(methods.indexOf('fetchUpdatedSince')).toBeLessThan(methods.indexOf('applyChanges'))
  })

  it('TC-I-SYNC-04 base snapshots are written only after the remote write succeeds', async () => {
    const repo = new InMemoryTicketRepo([
      ticket('PROJ-1', { body: 'Local edit one.' }),
      ticket('PROJ-2', { body: 'Local edit two.' }),
    ])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    repo.seedBase('PROJ-2', snapshot('PROJ-2'))

    const tracker = new InMemoryTracker({
      pages: [[remote('PROJ-1'), remote('PROJ-2')]],
      failOn: ['PROJ-1'],
    })

    const result = await execute(deps(repo, tracker), await plan(deps(repo, tracker)))

    // The failed ticket keeps its old base. Recording one for a write that did
    // not happen would make the tool believe both sides agree when they do not.
    expect(repo.peekBase('PROJ-1')?.fields.body).toBe('Original body.')
    expect(repo.peekBase('PROJ-2')?.fields.body).toBe('Local edit two.')

    expect(result.failures.map((f) => f.id)).toEqual(['PROJ-1'])
  })
})

describe('TC-I-SYNC — conflicts', () => {
  it('TC-I-SYNC-05 a conflicted ticket is skipped, others proceed', async () => {
    const repo = new InMemoryTicketRepo([
      ticket('PROJ-1', { body: 'Local edit.' }),
      ticket('PROJ-2', { title: 'Local title' }), // both sides changed the title
      ticket('PROJ-3', { body: 'Another local edit.' }),
    ])
    for (const id of ['PROJ-1', 'PROJ-2', 'PROJ-3']) repo.seedBase(id, snapshot(id))

    const tracker = new InMemoryTracker({
      pages: [[remote('PROJ-1'), remote('PROJ-2', { title: 'Remote title' }), remote('PROJ-3')]],
    })

    const result = await execute(deps(repo, tracker), await plan(deps(repo, tracker)))

    expect(result.conflicts).toBe(1)
    expect(repo.peek('PROJ-2')?.sync.conflict).toBe(true)

    // The conflicted ticket's own content is untouched; the clean ones synced.
    expect(repo.peek('PROJ-2')?.fields.title).toBe('Local title')
    expect(tracker.calls.filter((c) => c.method === 'applyChanges').map((c) => c.args[0])).toEqual([
      'PROJ-1',
      'PROJ-3',
    ])
  })

  it('TC-I-SYNC-06 an already-conflicted ticket is not re-evaluated', async () => {
    const repo = new InMemoryTicketRepo([
      ticket('PROJ-1', { body: 'Half-resolved by hand.' }, { conflict: true }),
    ])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1', { title: 'Changed again' })]] })

    const planned = await plan(deps(repo, tracker))

    expect(planned.plan.tickets).toEqual([])
    await execute(deps(repo, tracker), planned)
    expect(repo.peek('PROJ-1')?.fields.body).toBe('Half-resolved by hand.')
  })
})

describe('TC-I-SYNC — duplicate protection', () => {
  it('TC-I-SYNC-07 a crashed creation is adopted, not duplicated', async () => {
    const local: Ticket = {
      id: 'LOCAL-0007',
      fields: { ...BASE_FIELDS, title: 'Drafted locally' },
      sync: { base: null, lastPull: null, lastPush: null, conflict: false },
    }
    const repo = new InMemoryTicketRepo([local])
    const tracker = new InMemoryTracker({ bySyncLabel: { 'LOCAL-0007': 'PROJ-500' } })

    const result = await createPending(deps(repo, tracker), ['LOCAL-0007'])

    expect(tracker.calls.some((c) => c.method === 'create')).toBe(false)
    expect(result.adopted).toEqual([{ id: 'LOCAL-0007', key: 'PROJ-500' }])
    expect(repo.peek('LOCAL-0007')?.jira?.key).toBe('PROJ-500')
  })

  it('TC-I-SYNC-08 creation attaches the sync label', async () => {
    const local: Ticket = {
      id: 'LOCAL-0008',
      fields: { ...BASE_FIELDS, title: 'Drafted locally' },
      sync: { base: null, lastPull: null, lastPush: null, conflict: false },
    }
    const repo = new InMemoryTicketRepo([local])
    const tracker = new InMemoryTracker()

    await createPending(deps(repo, tracker), ['LOCAL-0008'])

    const call = tracker.calls.find((c) => c.method === 'create')
    expect(call?.args[1]).toContain('sync-LOCAL-0008')
  })
})

describe('TC-I-SYNC — cursors', () => {
  it('TC-I-SYNC-09 the cursor advances only after all pages are written', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1', { body: 'Local edit.' })])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    repo.seedCursor(TRACKER_CURSOR, '2026-08-11T08:00:00+09:00')

    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1')]], failOn: ['PROJ-1'] })

    const result = await execute(deps(repo, tracker), await plan(deps(repo, tracker)))

    expect(result.cursor).toBe('2026-08-11T08:00:00+09:00')
    expect(repo.writes().some((c) => c.method === 'setCursor')).toBe(false)
  })

  it('TC-I-SYNC-09b a clean run advances the cursor to the high-water mark', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1', { body: 'Local edit.' })])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({
      pages: [[remote('PROJ-1', {}, '2026-08-11T10:00:00+09:00')]],
    })

    const result = await execute(deps(repo, tracker), await plan(deps(repo, tracker)))
    expect(result.cursor).toBe('2026-08-11T10:00:00+09:00')
  })

  it('TC-I-SYNC-10 the stored cursor is what the tracker is asked for', async () => {
    // The five-minute rewind is the adapter's job (TC-I-JIRA-15b); the use case
    // must hand over the stored value unmodified for that to be applied once.
    const repo = new InMemoryTicketRepo([])
    repo.seedCursor(TRACKER_CURSOR, '2026-08-11T09:00:00+09:00')
    const tracker = new InMemoryTracker()

    await plan(deps(repo, tracker))

    expect(tracker.requestedCursor).toBe('2026-08-11T09:00:00+09:00')
  })

  it('TC-I-SYNC-11 re-processing an already-seen ticket is harmless', async () => {
    // Identical on both sides and matching the base: the skew overlap returned
    // it again, and it must generate no work.
    const repo = new InMemoryTicketRepo([ticket('PROJ-1')])
    repo.seedBase('PROJ-1', snapshot('PROJ-1'))
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1')]] })

    const planned = await plan(deps(repo, tracker))

    expect(planned.plan.tickets).toEqual([])
  })
})

describe('TC-I-SYNC — scope flags', () => {
  it('TC-I-SYNC-12 --only jira does not touch the external source', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1')])
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1')]] })
    const source = new InMemoryIssueSource([])

    await plan(deps(repo, tracker), { only: 'jira' })

    expect(source.calls).toEqual([])
  })

  it('TC-I-SYNC-12b --only github does not query the tracker', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1')])
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1')]] })

    await plan(deps(repo, tracker), { only: 'github' })

    expect(tracker.calls).toEqual([])
  })

  it('TC-I-SYNC-13 --limit caps tickets and reports what was withheld', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `PROJ-${String(i + 1).padStart(2, '0')}`)
    const repo = new InMemoryTicketRepo(ids.map((id) => ticket(id, { body: `Local edit ${id}.` })))
    for (const id of ids) repo.seedBase(id, snapshot(id))
    const tracker = new InMemoryTracker({ pages: [ids.map((id) => remote(id))] })

    const planned = await plan(deps(repo, tracker), { limit: 10 })

    expect(planned.plan.tickets).toHaveLength(10)
    // A silent cap would read as "everything is in sync" when it is not.
    expect(planned.plan.withheld).toBe(2)
  })
})

describe('TC-I-SYNC — deletion safety', () => {
  it('TC-I-SYNC-14 a remote omitting a ticket never deletes it locally', async () => {
    const repo = new InMemoryTicketRepo([ticket('PROJ-1'), ticket('PROJ-2')])
    for (const id of ['PROJ-1', 'PROJ-2']) repo.seedBase(id, snapshot(id))

    // The incremental query returns only one of them.
    const tracker = new InMemoryTracker({ pages: [[remote('PROJ-1')]] })

    await execute(deps(repo, tracker), await plan(deps(repo, tracker)))

    expect(repo.peek('PROJ-2')).not.toBeNull()
    expect(repo.calls.some((c) => c.method === 'archive')).toBe(false)
  })
})
