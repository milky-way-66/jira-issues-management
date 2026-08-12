/**
 * TC-U-MOVE — docs/testcase/unit/TC-U-move.md
 */

import { describe, expect, it } from 'vitest'
import { FixedClock, InMemoryTicketRepo } from '../../src/adapters/in-memory.js'
import type { TrackerPort } from '../../src/core/ports.js'
import type { FieldChange, RemoteTicket, Ticket, TicketId } from '../../src/core/ticket.js'
import { MoveError, moveTicket, type MoveDeps } from '../../src/core/use-cases/move.js'

const AT = '2026-08-12T09:00:00+09:00'

function fields(over: Partial<Ticket['fields']> = {}): Ticket['fields'] {
  return {
    title: 'A ticket',
    body: 'Body.',
    status: 'To Do',
    assignee: null,
    type: 'Task',
    parent: null,
    labels: [],
    priority: null,
    estimate: null,
    due: null,
    ...over,
  }
}

function ticket(over: Partial<Ticket> = {}, f: Partial<Ticket['fields']> = {}): Ticket {
  return {
    id: 'PROJ-1',
    fields: fields(f),
    jira: { key: 'PROJ-1', url: '', updated: AT },
    sync: { base: AT, lastPull: AT, lastPush: null, conflict: false },
    ...over,
  }
}

/**
 * A tracker whose read-back reflects the transition, and which can land a
 * ticket somewhere other than where it was sent.
 */
class StubTracker implements TrackerPort {
  readonly applied: { id: TicketId; changes: FieldChange[] }[] = []
  status: string

  constructor(
    private readonly opts: { status: string; lands?: string; reject?: string } = {
      status: 'To Do',
    },
  ) {
    this.status = opts.status
  }

  async *fetchUpdatedSince(): AsyncIterable<RemoteTicket> {}

  async fetchOne(id: TicketId): Promise<RemoteTicket | null> {
    return {
      key: id,
      fields: fields({ status: this.status, title: 'A ticket' }),
      updated: '2026-08-12T10:00:00+09:00',
    }
  }

  async create(): Promise<TicketId> {
    throw new Error('not used')
  }

  async applyChanges(id: TicketId, changes: FieldChange[]): Promise<void> {
    if (this.opts.reject) throw new Error(this.opts.reject)
    this.applied.push({ id, changes: [...changes] })
    this.status = this.opts.lands ?? (changes[0] as { to: string }).to
  }

  async findBySyncLabel(): Promise<TicketId | null> {
    return null
  }
}

function deps(repo: InMemoryTicketRepo, tracker: TrackerPort): MoveDeps {
  return { repo, tracker, clock: new FixedClock('2026-08-12T12:00:00+09:00') }
}

describe('refusals', () => {
  it('TC-U-MOVE-01 refuses an unknown ticket', async () => {
    const tracker = new StubTracker({ status: 'To Do' })

    await expect(
      moveTicket(deps(new InMemoryTicketRepo([]), tracker), 'PROJ-9', 'Done', { apply: true }),
    ).rejects.toThrow(/PROJ-9/)
    expect(tracker.applied).toHaveLength(0)
  })

  it('TC-U-MOVE-02 does nothing when the ticket is already in that status', async () => {
    const repo = new InMemoryTicketRepo([ticket({}, { status: 'In Progress' })])
    const tracker = new StubTracker({ status: 'In Progress' })

    const result = await moveTicket(deps(repo, tracker), 'PROJ-1', 'in progress', { apply: true })

    expect(result).toMatchObject({ unchanged: true, applied: false, to: 'In Progress' })
    expect(tracker.applied).toHaveLength(0)
  })

  it('TC-U-MOVE-03 refuses a conflicted ticket', async () => {
    const repo = new InMemoryTicketRepo([
      ticket({ sync: { base: AT, lastPull: AT, lastPush: null, conflict: true } }),
    ])
    const tracker = new StubTracker({ status: 'To Do' })

    await expect(
      moveTicket(deps(repo, tracker), 'PROJ-1', 'Done', { apply: true }),
    ).rejects.toThrow(/mgmt resolve/)
    expect(tracker.applied).toHaveLength(0)
  })

  it('TC-U-MOVE-04 refuses a ticket that does not exist in the tracker', async () => {
    const local: Ticket = {
      id: 'LOCAL-0001',
      fields: fields(),
      sync: { base: null, lastPull: null, lastPush: null, conflict: false },
    }
    const tracker = new StubTracker({ status: 'To Do' })

    await expect(
      moveTicket(deps(new InMemoryTicketRepo([local]), tracker), 'LOCAL-0001', 'Done', {
        apply: true,
      }),
    ).rejects.toThrow(/mgmt sync --apply/)
    expect(tracker.applied).toHaveLength(0)
  })

  it('TC-U-MOVE-04b refuses with a MoveError, not a bare Error', async () => {
    const tracker = new StubTracker({ status: 'To Do' })

    await expect(
      moveTicket(deps(new InMemoryTicketRepo([]), tracker), 'PROJ-9', 'Done', { apply: true }),
    ).rejects.toBeInstanceOf(MoveError)
  })
})

describe('dry run', () => {
  it('TC-U-MOVE-05 writes nothing anywhere', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    const tracker = new StubTracker({ status: 'To Do' })

    const result = await moveTicket(deps(repo, tracker), 'PROJ-1', 'Done', { apply: false })

    expect(result).toMatchObject({ applied: false, from: 'To Do', to: 'Done' })
    expect(tracker.applied).toHaveLength(0)
    expect(repo.peek('PROJ-1')!.fields.status).toBe('To Do')
  })
})

describe('applying', () => {
  it('TC-U-MOVE-06 sends the change as a transition', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    const tracker = new StubTracker({ status: 'To Do' })

    await moveTicket(deps(repo, tracker), 'PROJ-1', 'Done', { apply: true })

    expect(tracker.applied[0]).toEqual({
      id: 'PROJ-1',
      changes: [{ field: 'status', from: 'To Do', to: 'Done', viaTransition: true }],
    })
  })

  it('TC-U-MOVE-07 records the new status in the local file', async () => {
    const repo = new InMemoryTicketRepo([ticket()])

    await moveTicket(deps(repo, new StubTracker({ status: 'To Do' })), 'PROJ-1', 'Done', {
      apply: true,
    })

    expect(repo.peek('PROJ-1')!.fields.status).toBe('Done')
  })

  it('TC-U-MOVE-08 lands where the tracker says, not where it was sent', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    const tracker = new StubTracker({ status: 'To Do', lands: 'In Review' })

    const result = await moveTicket(deps(repo, tracker), 'PROJ-1', 'Done', { apply: true })

    expect(result.to).toBe('In Review')
    expect(result.requested).toBe('Done')
    expect(repo.peek('PROJ-1')!.fields.status).toBe('In Review')
  })

  it('TC-U-MOVE-09 records the new status in the base snapshot', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    await repo.writeBase('PROJ-1', { key: 'PROJ-1', fields: fields(), updated: AT })

    await moveTicket(deps(repo, new StubTracker({ status: 'To Do' })), 'PROJ-1', 'Done', {
      apply: true,
    })

    expect((await repo.readBase('PROJ-1'))!.fields.status).toBe('Done')
  })

  it('TC-U-MOVE-10 leaves every other base field alone', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    await repo.writeBase('PROJ-1', {
      key: 'PROJ-1',
      // The title in the tracker has since changed; the base must keep the old
      // one so the next sync still sees that difference and pulls it.
      fields: fields({ title: 'The title at the last sync' }),
      updated: AT,
    })

    await moveTicket(deps(repo, new StubTracker({ status: 'To Do' })), 'PROJ-1', 'Done', {
      apply: true,
    })

    const base = (await repo.readBase('PROJ-1'))!
    expect(base.fields.title).toBe('The title at the last sync')
    expect(base.fields.status).toBe('Done')
  })

  it('TC-U-MOVE-11 moves a ticket that has no base snapshot', async () => {
    const repo = new InMemoryTicketRepo([ticket()])

    await moveTicket(deps(repo, new StubTracker({ status: 'To Do' })), 'PROJ-1', 'Done', {
      apply: true,
    })

    expect(repo.peek('PROJ-1')!.fields.status).toBe('Done')
    expect(await repo.readBase('PROJ-1')).toBeNull()
  })

  it('TC-U-MOVE-12 stamps the push on the ticket', async () => {
    const repo = new InMemoryTicketRepo([ticket()])

    await moveTicket(deps(repo, new StubTracker({ status: 'To Do' })), 'PROJ-1', 'Done', {
      apply: true,
    })

    expect(repo.peek('PROJ-1')!.sync.lastPush).toBe('2026-08-12T12:00:00+09:00')
  })

  it('TC-U-MOVE-13 leaves the file alone when the tracker refuses', async () => {
    const repo = new InMemoryTicketRepo([ticket()])
    const tracker = new StubTracker({ status: 'To Do', reject: 'no transition to "Done"' })

    await expect(
      moveTicket(deps(repo, tracker), 'PROJ-1', 'Done', { apply: true }),
    ).rejects.toThrow(/no transition/)
    expect(repo.peek('PROJ-1')!.fields.status).toBe('To Do')
  })
})
