/**
 * Moves one ticket to another status — the write behind a drag on the board.
 *
 * Status is a tracker-owned field, so this is a push: the transition happens in
 * the tracker first, and the local file is brought into line with whatever the
 * tracker actually did. A workflow post-function can land a ticket somewhere
 * other than where it was dropped, and the board must show the truth rather
 * than the intent.
 *
 * The base snapshot is updated in *one field only*. Writing the whole remote
 * ticket into the base would be easier and wrong: it would swallow any other
 * change made in the tracker since the last sync, and the next `mgmt sync`
 * would never pull it.
 */

import type { ClockPort, TicketRepoPort, TrackerPort } from '../ports.js'
import type { RemoteTicket, TicketId } from '../ticket.js'

export class MoveError extends Error {}

export interface MoveDeps {
  repo: TicketRepoPort
  tracker: TrackerPort
  clock: ClockPort
}

export interface MoveResult {
  id: TicketId
  from: string
  /** Where it ended up — not necessarily where it was asked to go. */
  to: string
  /** The status that was requested, when the tracker landed it elsewhere. */
  requested: string
  applied: boolean
  unchanged: boolean
}

export async function moveTicket(
  deps: MoveDeps,
  id: TicketId,
  to: string,
  opts: { apply: boolean },
): Promise<MoveResult> {
  const ticket = await deps.repo.load(id)
  if (!ticket) throw new MoveError(`no such ticket: ${id}`)

  const from = ticket.fields.status
  const key = ticket.jira?.key ?? null

  if (from.trim().toLowerCase() === to.trim().toLowerCase()) {
    return { id, from, to: from, requested: to, applied: false, unchanged: true }
  }

  // A conflicted ticket is left alone here for the same reason `plan()` skips
  // it: a transition would settle one field of a disagreement a human is in the
  // middle of resolving.
  if (ticket.sync.conflict) {
    throw new MoveError(
      `${id} is conflicted. Settle it with \`mgmt resolve\` before moving it.`,
    )
  }

  if (!key) {
    throw new MoveError(
      `${id} does not exist in the tracker yet. Run \`mgmt sync --apply\` to create it first.`,
    )
  }

  if (!opts.apply) {
    return { id, from, to, requested: to, applied: false, unchanged: false }
  }

  await deps.tracker.applyChanges(key, [
    { field: 'status', from, to, viaTransition: true },
  ])

  // Read back rather than assume. This is also what makes the local file
  // correct when a post-function moved the ticket somewhere else entirely.
  const remote = await deps.tracker.fetchOne(key)
  const landed = remote?.fields.status ?? to

  ticket.fields.status = landed
  ticket.sync.lastPush = deps.clock.now()
  await deps.repo.save(ticket)

  await updateBaseStatus(deps.repo, key, landed, remote)

  return { id, from, to: landed, requested: to, applied: true, unchanged: false }
}

/**
 * Records the new status in the merge base, leaving every other field as it
 * was. Anything else that changed in the tracker meanwhile is still a pull the
 * next sync will find.
 */
async function updateBaseStatus(
  repo: TicketRepoPort,
  key: TicketId,
  status: string,
  remote: RemoteTicket | null,
): Promise<void> {
  const base = await repo.readBase(key)
  if (!base) return

  await repo.writeBase(key, {
    ...base,
    fields: { ...base.fields, status },
    updated: remote?.updated ?? base.updated,
  })
}
