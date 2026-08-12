/**
 * `mgmt resolve` — settle a conflicted ticket.
 *
 * A conflict means the same field changed on both sides since the last sync.
 * The tool will not guess which is right; this use case records the human's
 * decision and clears the flag so the next sync proceeds.
 *
 * Taking a side does *not* mean copying the whole ticket. Only the conflicted
 * fields move, because the non-conflicted ones already merged cleanly and
 * overwriting them would discard a change nobody disputed.
 */

import { merge3 } from '../merge3.js'
import { resolveOwner } from '../policy.js'
import type { ClockPort, TicketRepoPort, TrackerPort } from '../ports.js'
import type { Conflict, FieldSet, Ticket } from '../ticket.js'

export type Take = 'local' | 'jira'

export interface ResolveDeps {
  repo: TicketRepoPort
  tracker: TrackerPort
  clock: ClockPort
}

export interface ResolveResult {
  id: string
  /** Fields whose value changed as a result. */
  applied: string[]
  /** True when the decision still has to be pushed on the next sync. */
  pendingPush: boolean
}

export class ResolveError extends Error {}

/**
 * Recomputes what is in conflict, right now.
 *
 * The ticket file records *that* it is conflicted, not *what* conflicts —
 * storing the detail would let it go stale against the tracker, and a resolve
 * driven by a stale conflict list writes the wrong value. It is cheap to derive
 * and always current, so it is derived.
 */
export async function conflictsFor(deps: ResolveDeps, id: string): Promise<Conflict[]> {
  const ticket = await load(deps, id)
  const key = ticket.jira?.key ?? id

  const remote = await deps.tracker.fetchOne(key)
  if (!remote) return []

  const base = await deps.repo.readBase(key)

  return merge3({
    id,
    base: base?.fields ?? null,
    local: ticket.fields,
    remote: remote.fields,
  }).conflicts
}

/**
 * `--done` — the human edited the file by hand and is asserting it is settled.
 * Nothing is copied, but the base still advances: the file as it stands is now
 * the agreed starting point, and leaving the base behind would make the very
 * next sync re-derive the conflict that was just settled.
 */
export async function markResolved(deps: ResolveDeps, id: string): Promise<ResolveResult> {
  const ticket = await load(deps, id)
  await deps.repo.save({ ...ticket, sync: { ...ticket.sync, conflict: false } })
  await acknowledgeRemote(deps, ticket)
  return { id, applied: [], pendingPush: true }
}

/**
 * Records the tracker's current state as the new merge base.
 *
 * This is what "resolved" means mechanically. Without it the base still holds
 * the pre-conflict value, both sides still read as changed, and the next sync
 * raises the identical conflict — the decision would never stick.
 */
async function acknowledgeRemote(deps: ResolveDeps, ticket: Ticket): Promise<void> {
  const key = ticket.jira?.key ?? ticket.id
  const remote = await deps.tracker.fetchOne(key)
  if (remote) await deps.repo.writeBase(key, remote)
}

export async function resolve(
  deps: ResolveDeps,
  id: string,
  take: Take,
  conflicts: readonly Conflict[],
): Promise<ResolveResult> {
  const ticket = await load(deps, id)

  if (!ticket.sync.conflict) {
    throw new ResolveError(`${id} is not conflicted; there is nothing to resolve.`)
  }

  const fields: FieldSet = { ...ticket.fields, labels: [...ticket.fields.labels] }
  const applied: string[] = []

  for (const conflict of conflicts) {
    const winner = take === 'local' ? conflict.local : conflict.remote

    // An explicit --take overrides the ownership default. The default exists to
    // stop the tool acting unilaterally, not to overrule a human.
    resolveOwner(conflict.field, take)

    if (conflict.field === 'labels') {
      fields.labels = Array.isArray(winner) ? [...winner].sort() : []
    } else if (typeof winner === 'string' || winner === null) {
      assignScalar(fields, conflict.field, winner)
    }
    applied.push(conflict.field)
  }

  await deps.repo.save({
    ...ticket,
    fields,
    sync: { ...ticket.sync, conflict: false, lastPull: deps.clock.now() },
  })

  await acknowledgeRemote(deps, ticket)

  // Taking the tracker's side needs no push — that value is already there.
  return { id, applied, pendingPush: take === 'local' }
}

function assignScalar(fields: FieldSet, field: string, value: string | null): void {
  switch (field) {
    case 'title':
    case 'body':
    case 'status':
    case 'type':
      fields[field] = value ?? ''
      break
    case 'assignee':
    case 'parent':
    case 'priority':
    case 'estimate':
    case 'due':
      fields[field] = value
      break
  }
}

async function load(deps: ResolveDeps, id: string): Promise<Ticket> {
  const ticket = await deps.repo.load(id)
  if (!ticket) throw new ResolveError(`no such ticket: ${id}`)
  return ticket
}
