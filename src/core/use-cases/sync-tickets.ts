/**
 * The sync use case: pull from the tracker, merge, push back.
 *
 * The whole design turns on one property — **the plan is computed before
 * anything is written, and `apply` executes that same object**. A preview that
 * is recomputed at apply time is not a preview; it is a second, unverified run.
 * That is why `plan()` and `execute()` are separate functions here rather than
 * a single `sync(apply: boolean)`.
 *
 * Ordering is deliberate and load-bearing:
 *
 *   1. Read everything. No write happens while reads are outstanding.
 *   2. Merge. Pure, no I/O.
 *   3. Write local changes, then remote ones, then the base snapshot — per
 *      ticket, and only ever forward. A base snapshot recorded for a write that
 *      did not happen desynchronises that ticket permanently: the tool would
 *      believe both sides agree when they do not.
 *
 * Nothing in this file deletes. Absence from an incremental query means "not
 * recently updated", never "deleted".
 */

import { merge3 } from '../merge3.js'
import { isAutoPushable, autoPushRefusal, syncLabel } from '../policy.js'
import type { ClockPort, TicketRepoPort, TrackerPort } from '../ports.js'
import type {
  FieldChange,
  FieldSet,
  Instant,
  RemoteTicket,
  SyncPlan,
  Ticket,
  TicketPlan,
} from '../ticket.js'
import { isEmptyPlan, isLabelsChange } from '../ticket.js'

/** Cursor key for the tracker side. */
export const TRACKER_CURSOR = 'jira'

export interface SyncOptions {
  /** Cap on tickets touched. Withheld tickets are reported, never dropped silently. */
  limit?: number
  /** Restrict to one side. Absent means both. */
  only?: 'jira' | 'github'
}

export interface SyncDeps {
  repo: TicketRepoPort
  tracker: TrackerPort
  clock: ClockPort
}

export interface SyncResult {
  plan: SyncPlan
  applied: boolean
  /** Tickets whose remote write failed. The run continues past each one. */
  failures: { id: string; message: string }[]
  conflicts: number
  /** Advanced only when every page was processed without error. */
  cursor: Instant | null
}

/**
 * Everything a ticket needs to be merged and then written, gathered in the read
 * phase so the write phase performs no reads.
 */
interface Candidate {
  ticket: Ticket
  remote: RemoteTicket | null
  base: FieldSet | null
  plan: TicketPlan
}

// ── Planning ────────────────────────────────────────────────────────────────

export async function plan(deps: SyncDeps, opts: SyncOptions = {}): Promise<{
  plan: SyncPlan
  candidates: Candidate[]
  /** The furthest remote timestamp seen; the cursor advances to it on success. */
  highWater: Instant | null
}> {
  const { repo, tracker } = deps

  const remotes = new Map<string, RemoteTicket>()
  let highWater: Instant | null = null

  if (opts.only !== 'github') {
    const cursor = await repo.getCursor(TRACKER_CURSOR)
    for await (const remote of tracker.fetchUpdatedSince(cursor)) {
      remotes.set(remote.key, remote)
      if (highWater === null || remote.updated > highWater) highWater = remote.updated
    }
  }

  const candidates: Candidate[] = []
  let withheld = 0

  for (const id of await repo.list()) {
    const ticket = await repo.load(id)
    if (!ticket) continue

    // A ticket already marked conflicted is left entirely alone. Recomputing it
    // would rewrite conflict markers around a human's in-progress edit.
    if (ticket.sync.conflict) continue

    const remote = remotes.get(ticket.jira?.key ?? id) ?? null
    const base = await repo.readBase(ticket.jira?.key ?? id)

    const ticketPlan = remote
      ? withPushPolicy(merge3({ id, base: base?.fields ?? null, local: ticket.fields, remote: remote.fields }))
      : emptyPlan(id)

    if (isEmptyPlan(ticketPlan)) continue

    if (opts.limit !== undefined && candidates.length >= opts.limit) {
      withheld++
      continue
    }

    candidates.push({ ticket, remote, base: base?.fields ?? null, plan: ticketPlan })
  }

  return {
    plan: { tickets: candidates.map((c) => c.plan), withheld },
    candidates,
    highWater,
  }
}

/**
 * Demotes changes the ownership policy refuses to push automatically. The merge
 * decides *what* differs; policy decides what the tool is allowed to do about
 * it unattended.
 */
function withPushPolicy(p: TicketPlan): TicketPlan {
  const allowed: FieldChange[] = []

  for (const change of p.push) {
    if (isAutoPushable(change.field)) {
      allowed.push(change)
      continue
    }
    p.warnings.push(
      isLabelsChange(change)
        ? autoPushRefusal(change.field, null, null)
        : autoPushRefusal(change.field, change.from, change.to),
    )
  }

  return { ...p, push: allowed }
}

function emptyPlan(id: string): TicketPlan {
  return { id, pull: [], push: [], conflicts: [], baseUpdateOnly: false, warnings: [] }
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Executes a previously computed plan. Takes the candidates from `plan()` so
 * that what runs is provably what was shown — nothing is recomputed here.
 */
export async function execute(
  deps: SyncDeps,
  planned: Awaited<ReturnType<typeof plan>>,
): Promise<SyncResult> {
  const { repo, tracker, clock } = deps
  const failures: SyncResult['failures'] = []
  let allSucceeded = true

  for (const candidate of planned.candidates) {
    const { ticket, remote, plan: p } = candidate

    if (p.conflicts.length > 0) {
      // Mark it and stop. Writing half a conflicted ticket is worse than
      // writing none of it.
      await repo.save({ ...ticket, sync: { ...ticket.sync, conflict: true } })
      continue
    }

    try {
      const updated = applyPull(ticket, p.pull, clock.now())

      if (p.push.length > 0 && remote) {
        await tracker.applyChanges(remote.key, p.push)
        updated.sync.lastPush = clock.now()
      }

      await repo.save(updated)

      // Only now, after every write for this ticket succeeded, does the base
      // move forward.
      if (remote) await repo.writeBase(remote.key, projectBase(remote, p))
    } catch (err) {
      allSucceeded = false
      failures.push({ id: ticket.id, message: (err as Error).message })
    }
  }

  // The cursor advances only if the entire run completed. Advancing past a
  // failure would skip that ticket forever.
  let cursor = await repo.getCursor(TRACKER_CURSOR)
  if (allSucceeded && planned.highWater !== null) {
    cursor = planned.highWater
    await repo.setCursor(TRACKER_CURSOR, cursor)
  }

  return {
    plan: planned.plan,
    applied: true,
    failures,
    conflicts: planned.plan.tickets.filter((t) => t.conflicts.length > 0).length,
    cursor,
  }
}

/** Folds pulled changes into the local ticket. Pure. */
function applyPull(ticket: Ticket, changes: readonly FieldChange[], now: Instant): Ticket {
  const fields: FieldSet = { ...ticket.fields, labels: [...ticket.fields.labels] }

  for (const change of changes) {
    if (isLabelsChange(change)) {
      const labels = new Set(fields.labels)
      for (const l of change.add) labels.add(l)
      for (const l of change.remove) labels.delete(l)
      fields.labels = [...labels].sort()
      continue
    }

    switch (change.field) {
      case 'title':
      case 'body':
      case 'status':
      case 'type':
        fields[change.field] = change.to ?? ''
        break
      default:
        fields[change.field] = change.to
    }
  }

  return {
    ...ticket,
    fields,
    sync: { ...ticket.sync, lastPull: now, conflict: false },
  }
}

/**
 * The snapshot to record as the new base: the remote as read, plus anything we
 * just pushed to it. Recording the un-pushed remote would make the next run
 * plan the same push again.
 */
function projectBase(remote: RemoteTicket, p: TicketPlan): RemoteTicket {
  const fields: FieldSet = { ...remote.fields, labels: [...remote.fields.labels] }

  for (const change of p.push) {
    if (isLabelsChange(change)) {
      const labels = new Set(fields.labels)
      for (const l of change.add) labels.add(l)
      for (const l of change.remove) labels.delete(l)
      fields.labels = [...labels].sort()
      continue
    }
    switch (change.field) {
      case 'title':
      case 'body':
      case 'status':
      case 'type':
        fields[change.field] = change.to ?? ''
        break
      default:
        fields[change.field] = change.to
    }
  }

  return { ...remote, fields }
}

// ── Creation ────────────────────────────────────────────────────────────────

/**
 * Creates tracker issues for local-only tickets.
 *
 * Kept apart from the merge path because creation is the one irreversible
 * operation here: a duplicate issue in a shared tracker has to be deleted by a
 * human. The label lookup is what makes it recoverable — if the tracker created
 * the issue and this process died before recording the key, the next run adopts
 * it instead of creating a second one.
 */
export async function createPending(
  deps: SyncDeps,
  ids: readonly string[],
): Promise<{ created: { id: string; key: string }[]; adopted: { id: string; key: string }[] }> {
  const created: { id: string; key: string }[] = []
  const adopted: { id: string; key: string }[] = []

  for (const id of ids) {
    const ticket = await deps.repo.load(id)
    if (!ticket || ticket.jira) continue

    const existing = await deps.tracker.findBySyncLabel(id)
    const key = existing ?? (await deps.tracker.create({
      localId: id,
      fields: { ...ticket.fields, labels: [...ticket.fields.labels, syncLabel(id)].sort() },
    }))

    await deps.repo.save({
      ...ticket,
      jira: { key, url: '', updated: deps.clock.now() },
    })
    ;(existing ? adopted : created).push({ id, key })
  }

  return { created, adopted }
}
