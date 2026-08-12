/**
 * Three-way merge — the algorithm the whole tool exists to get right.
 *
 * Pure: no I/O, no clock, no randomness. A bug here damages real tickets in a
 * shared system, so it is specified before it is written
 * (docs/testcase/unit/TC-U-merge3.md) and covered exhaustively.
 *
 *   BASE   the remote state at the last successful sync
 *   LOCAL  what is on disk now
 *   REMOTE what the tracker holds now
 */

import {
  extractLocalOnly,
  isAutoPushable,
  normaliseBody,
  normaliseLabels,
  normaliseScalar,
  autoPushRefusal,
  reinsertLocalOnly,
  requiresTransition,
  stripLocalOnly,
} from './policy.js'
import type {
  Conflict,
  FieldChange,
  FieldSet,
  ScalarFieldName,
  TicketId,
  TicketPlan,
} from './ticket.js'

const SCALAR_FIELDS: readonly ScalarFieldName[] = [
  'title',
  'body',
  'status',
  'assignee',
  'type',
  'parent',
  'priority',
  'estimate',
  'due',
]

export interface Merge3Input {
  id: TicketId
  /** Null when no snapshot exists — see the "no base" rule below. */
  base: FieldSet | null
  local: FieldSet
  remote: FieldSet
}

export function merge3(input: Merge3Input): TicketPlan {
  const { id, base, local, remote } = input

  const plan: TicketPlan = {
    id,
    pull: [],
    push: [],
    conflicts: [],
    baseUpdateOnly: false,
    warnings: [],
  }

  let converged = false

  for (const field of SCALAR_FIELDS) {
    const outcome =
      field === 'body'
        ? mergeBody(base, local, remote)
        : mergeScalar(field, base, local, remote)

    if (outcome.kind === 'pull') plan.pull.push(outcome.change)
    else if (outcome.kind === 'push') plan.push.push(outcome.change)
    else if (outcome.kind === 'conflict') plan.conflicts.push(outcome.conflict)
    else if (outcome.kind === 'warn') plan.warnings.push(outcome.message)
    else if (outcome.kind === 'converged') converged = true
  }

  const labels = mergeLabels(base, local, remote)
  if (labels.pull) plan.pull.push(labels.pull)
  if (labels.push) plan.push.push(labels.push)
  if (labels.conflict) plan.conflicts.push(labels.conflict)
  if (labels.converged) converged = true

  // Both sides made the same change independently: nothing to send, but the
  // recorded snapshot is stale and must catch up.
  plan.baseUpdateOnly =
    converged && plan.pull.length === 0 && plan.push.length === 0 && plan.conflicts.length === 0

  return plan
}

// ── Scalars ─────────────────────────────────────────────────────────────────

type Outcome =
  | { kind: 'none' }
  | { kind: 'converged' }
  | { kind: 'pull'; change: FieldChange }
  | { kind: 'push'; change: FieldChange }
  | { kind: 'conflict'; conflict: Conflict }
  | { kind: 'warn'; message: string }

function mergeScalar(
  field: ScalarFieldName,
  base: FieldSet | null,
  local: FieldSet,
  remote: FieldSet,
): Outcome {
  const l = normaliseScalar(local[field] as string | null)
  const r = normaliseScalar(remote[field] as string | null)

  if (base === null) return withoutBase(field, l, r)

  const b = normaliseScalar(base[field] as string | null)
  return decide(field, b, l, r)
}

function mergeBody(base: FieldSet | null, local: FieldSet, remote: FieldSet): Outcome {
  // Compare the *pushable* projection: what the tracker can actually see. An
  // edit confined to a local-only block changes nothing remotely observable and
  // must not trigger a write. (TC-U-LOCAL-09)
  const l = normaliseBody(stripLocalOnly(local.body))
  const r = normaliseBody(remote.body)

  const decision =
    base === null
      ? withoutBase('body', l, r)
      : decide('body', normaliseBody(base.body), l, r)

  // A pull replaces the body with the remote text, so the user's local-only
  // blocks have to be carried over or they would be silently destroyed.
  if (decision.kind === 'pull') {
    const preserved = extractLocalOnly(local.body)
    return {
      kind: 'pull',
      change: {
        field: 'body',
        from: local.body,
        to: reinsertLocalOnly(remote.body, preserved),
      },
    }
  }

  return decision
}

/**
 * With no snapshot there is no evidence about which side moved. Guessing here
 * is exactly how edits get destroyed, so any difference is a conflict.
 * (TC-U-MERGE-09)
 */
function withoutBase(field: ScalarFieldName, l: string | null, r: string | null): Outcome {
  if (l === r) return { kind: 'none' }
  return { kind: 'conflict', conflict: { field, base: null, local: l, remote: r } }
}

function decide(
  field: ScalarFieldName,
  b: string | null,
  l: string | null,
  r: string | null,
): Outcome {
  const localChanged = l !== b
  const remoteChanged = r !== b

  if (!localChanged && !remoteChanged) return { kind: 'none' }

  if (!localChanged && remoteChanged) {
    return { kind: 'pull', change: { field, from: b, to: r } }
  }

  if (localChanged && !remoteChanged) {
    if (!isAutoPushable(field)) return { kind: 'warn', message: autoPushRefusal(field, b, l) }
    return { kind: 'push', change: scalarChange(field, b, l) }
  }

  if (l === r) return { kind: 'converged' }

  return { kind: 'conflict', conflict: { field, base: b, local: l, remote: r } }
}

function scalarChange(field: ScalarFieldName, from: string | null, to: string | null): FieldChange {
  return requiresTransition(field)
    ? { field, from, to, viaTransition: true }
    : { field, from, to }
}

// ── Labels ──────────────────────────────────────────────────────────────────

interface LabelOutcome {
  pull?: FieldChange
  push?: FieldChange
  conflict?: Conflict
  converged?: boolean
}

/**
 * Labels merge as a set, never as a wholesale array replacement — overwriting
 * would discard labels added by other people or automation between two syncs.
 * (TC-U-MERGE-10)
 */
function mergeLabels(base: FieldSet | null, local: FieldSet, remote: FieldSet): LabelOutcome {
  const l = normaliseLabels(local.labels)
  const r = normaliseLabels(remote.labels)

  if (base === null) {
    if (sameSet(l, r)) return {}
    return { conflict: { field: 'labels', base: null, local: l, remote: r } }
  }

  const b = normaliseLabels(base.labels)

  const localAdded = difference(l, b)
  const localRemoved = difference(b, l)
  const remoteAdded = difference(r, b)
  const remoteRemoved = difference(b, r)

  const removed = new Set([...localRemoved, ...remoteRemoved])
  const final = normaliseLabels(
    [...b, ...localAdded, ...remoteAdded].filter((x) => !removed.has(x)),
  )

  const out: LabelOutcome = {}

  const pushAdd = difference(final, r)
  const pushRemove = difference(r, final)
  if (pushAdd.length > 0 || pushRemove.length > 0) {
    out.push = { field: 'labels', add: pushAdd, remove: pushRemove }
  }

  const pullAdd = difference(final, l)
  const pullRemove = difference(l, final)
  if (pullAdd.length > 0 || pullRemove.length > 0) {
    out.pull = { field: 'labels', add: pullAdd, remove: pullRemove }
  }

  if (!out.push && !out.pull && !sameSet(l, b)) out.converged = true

  return out
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const exclude = new Set(b)
  return a.filter((x) => !exclude.has(x))
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
