/**
 * In-memory implementations of every port, backed by `Map`s.
 *
 * These exist so the sync use case can be tested for *orchestration* — what it
 * decides, in what order, and what it refuses — without a filesystem or a
 * network to slow it down or add failure modes of their own.
 *
 * Every method records its call. That is what makes "dry-run wrote nothing" an
 * assertion rather than a hope: the test does not check that the data is
 * unchanged (which a compensating bug could satisfy), it checks that no write
 * method was ever entered.
 *
 * They live in `adapters/` rather than `test/` because they are adapters, and
 * because `mgmt sync --dry-run` against a scratch workspace uses the same code.
 */

import type {
  ClockPort,
  IssueSourcePort,
  TicketRepoPort,
  TrackerPort,
} from '../core/ports.js'
import type {
  ExternalIssue,
  FieldChange,
  Instant,
  RemoteTicket,
  Ticket,
  TicketDraft,
  TicketId,
} from '../core/ticket.js'

export interface CallLog {
  calls: { method: string; args: unknown[] }[]
  /** Methods that mutate state. Used to assert a dry run stayed read-only. */
  writes(): { method: string; args: unknown[] }[]
}

const WRITE_METHODS = new Set([
  'save',
  'archive',
  'writeBase',
  'setCursor',
  'create',
  'applyChanges',
])

function recorder(): CallLog & { record(method: string, ...args: unknown[]): void } {
  const calls: { method: string; args: unknown[] }[] = []
  return {
    calls,
    record: (method, ...args) => calls.push({ method, args }),
    writes: () => calls.filter((c) => WRITE_METHODS.has(c.method)),
  }
}

// ── Repository ──────────────────────────────────────────────────────────────

export class InMemoryTicketRepo implements TicketRepoPort {
  private tickets = new Map<TicketId, Ticket>()
  private archived = new Map<TicketId, Ticket>()
  private bases = new Map<TicketId, RemoteTicket>()
  private cursors = new Map<string, Instant>()

  private readonly log = recorder()
  readonly calls = this.log.calls
  readonly writes = () => this.log.writes()

  constructor(seed: readonly Ticket[] = []) {
    for (const t of seed) this.tickets.set(t.id, clone(t))
  }

  async list(): Promise<TicketId[]> {
    this.log.record('list')
    return [...this.tickets.keys()].sort()
  }

  async load(id: TicketId): Promise<Ticket | null> {
    this.log.record('load', id)
    const found = this.tickets.get(id)
    return found ? clone(found) : null
  }

  async save(ticket: Ticket): Promise<void> {
    this.log.record('save', ticket.id)
    this.tickets.set(ticket.id, clone(ticket))
  }

  async archive(id: TicketId): Promise<void> {
    this.log.record('archive', id)
    const found = this.tickets.get(id)
    if (!found) return
    this.archived.set(id, found)
    this.tickets.delete(id)
  }

  async readBase(id: TicketId): Promise<RemoteTicket | null> {
    this.log.record('readBase', id)
    const found = this.bases.get(id)
    return found ? clone(found) : null
  }

  async writeBase(id: TicketId, snapshot: RemoteTicket): Promise<void> {
    this.log.record('writeBase', id)
    this.bases.set(id, clone(snapshot))
  }

  async getCursor(key: string): Promise<Instant | null> {
    this.log.record('getCursor', key)
    return this.cursors.get(key) ?? null
  }

  async setCursor(key: string, value: Instant): Promise<void> {
    this.log.record('setCursor', key, value)
    this.cursors.set(key, value)
  }

  async highestLocalId(): Promise<number> {
    this.log.record('highestLocalId')
    let highest = 0
    for (const id of [...this.tickets.keys(), ...this.archived.keys()]) {
      const m = id.match(/^LOCAL-(\d+)$/)
      if (m) highest = Math.max(highest, Number(m[1]))
    }
    return highest
  }

  // ── inspection, for tests ─────────────────────────────────────────────────

  peek(id: TicketId): Ticket | null {
    return this.tickets.get(id) ?? null
  }

  peekBase(id: TicketId): RemoteTicket | null {
    return this.bases.get(id) ?? null
  }

  peekArchived(id: TicketId): Ticket | null {
    return this.archived.get(id) ?? null
  }

  /** Sets a base without recording it as a write, for arranging a scenario. */
  seedBase(id: TicketId, snapshot: RemoteTicket): void {
    this.bases.set(id, clone(snapshot))
  }

  seedCursor(key: string, value: Instant): void {
    this.cursors.set(key, value)
  }
}

// ── Tracker ─────────────────────────────────────────────────────────────────

export interface InMemoryTrackerOptions {
  /** Pages yielded by `fetchUpdatedSince`, in order. */
  pages?: RemoteTicket[][]
  /** Ticket keys whose `applyChanges` should throw, simulating a partial failure. */
  failOn?: readonly TicketId[]
  /** Existing issues discoverable by sync label, keyed by local id. */
  bySyncLabel?: Record<string, TicketId>
  /** Throws when this page index is reached. */
  throwOnPage?: number
}

export class InMemoryTracker implements TrackerPort {
  private readonly log = recorder()
  readonly calls = this.log.calls
  readonly writes = () => this.log.writes()

  /** The lower bound the use case asked for. Asserts cursor rewind behaviour. */
  requestedCursor: Instant | null | undefined

  private created = 0

  constructor(private readonly opts: InMemoryTrackerOptions = {}) {}

  async *fetchUpdatedSince(cursor: Instant | null): AsyncIterable<RemoteTicket> {
    this.log.record('fetchUpdatedSince', cursor)
    this.requestedCursor = cursor

    const pages = this.opts.pages ?? []
    for (let i = 0; i < pages.length; i++) {
      if (this.opts.throwOnPage === i) throw new Error(`page ${i} failed`)
      for (const ticket of pages[i] ?? []) yield clone(ticket)
    }
  }

  async fetchOne(id: TicketId): Promise<RemoteTicket | null> {
    this.log.record('fetchOne', id)
    for (const page of this.opts.pages ?? []) {
      const found = page.find((t) => t.key === id)
      if (found) return clone(found)
    }
    return null
  }

  async create(draft: TicketDraft): Promise<TicketId> {
    this.log.record('create', draft.localId, draft.fields.labels)
    return `PROJ-${900 + ++this.created}`
  }

  async applyChanges(id: TicketId, changes: FieldChange[]): Promise<void> {
    this.log.record('applyChanges', id, changes)
    if (this.opts.failOn?.includes(id)) throw new Error(`tracker rejected ${id}`)
  }

  async findBySyncLabel(localId: string): Promise<TicketId | null> {
    this.log.record('findBySyncLabel', localId)
    return this.opts.bySyncLabel?.[localId] ?? null
  }
}

// ── Issue source ────────────────────────────────────────────────────────────

export class InMemoryIssueSource implements IssueSourcePort {
  private readonly log = recorder()
  readonly calls = this.log.calls

  constructor(private readonly issues: readonly ExternalIssue[] = []) {}

  async *fetchUpdatedSince(cursor: Instant | null): AsyncIterable<ExternalIssue> {
    this.log.record('fetchUpdatedSince', cursor)
    for (const issue of this.issues) {
      if (cursor === null || issue.updatedAt >= cursor) yield clone(issue)
    }
  }

  async *fetchAll(): AsyncIterable<ExternalIssue> {
    this.log.record('fetchAll')
    for (const issue of this.issues) yield clone(issue)
  }
}

// ── Clock ───────────────────────────────────────────────────────────────────

/** Pinned by default. A test that depends on real time is a test that flakes. */
export class FixedClock implements ClockPort {
  constructor(private instant: Instant = '2026-08-11T09:00:00+09:00') {}

  now(): Instant {
    return this.instant
  }

  set(instant: Instant): void {
    this.instant = instant
  }
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
