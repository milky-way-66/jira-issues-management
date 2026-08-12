/**
 * Domain types. Pure data — no behaviour, no I/O, no provider vocabulary.
 *
 * Nothing in this file may mention Jira REST shapes (`customfield_*`,
 * `accountId`, transition ids) or GitHub shapes. Adapters map to and from these
 * types at the boundary; see docs/architecture.md.
 */

/** ISO-8601 instant, e.g. `2026-08-11T09:00:00+09:00`. */
export type Instant = string

/** `PROJ-123` once it exists remotely, `LOCAL-0007` before that. */
export type TicketId = string

export type FieldName =
  | 'title'
  | 'body'
  | 'status'
  | 'assignee'
  | 'type'
  | 'parent'
  | 'labels'
  | 'priority'
  | 'estimate'
  | 'due'

export type ScalarFieldName = Exclude<FieldName, 'labels'>

/**
 * The synchronisable content of a ticket, in canonical form.
 *
 * `body` is always Markdown. Conversion to and from a tracker's own markup is
 * an adapter concern, which is what keeps a Jira Cloud (ADF) adapter possible
 * without touching the core.
 */
export interface FieldSet {
  title: string
  /** Markdown. May contain local-only blocks when it comes from a local file. */
  body: string
  status: string
  assignee: string | null
  type: string
  parent: string | null
  labels: string[]
  priority: string | null
  estimate: string | null
  due: string | null
}

/** A ticket as it exists in the tracker, normalised. */
export interface RemoteTicket {
  key: TicketId
  fields: FieldSet
  updated: Instant
}

/** An issue in the external, read-only source. */
export interface ExternalIssue {
  owner: string
  repo: string
  number: number
  title: string
  body: string
  state: 'open' | 'closed'
  labels: string[]
  author: string
  createdAt: Instant
  updatedAt: Instant
}

/** A ticket that does not exist in the tracker yet. */
export interface TicketDraft {
  localId: TicketId
  fields: FieldSet
  /** Set when the draft was promoted from an external issue. */
  source?: { owner: string; repo: string; number: number }
}

export interface JiraLink {
  key: TicketId
  url: string
  updated: Instant
}

export interface GithubLink {
  repo: string
  number: number
  url: string
  state: 'open' | 'closed'
  updated: Instant
}

export interface SyncMeta {
  base: string | null
  lastPull: Instant | null
  lastPush: Instant | null
  conflict: boolean
}

/** A ticket as stored locally. */
export interface Ticket {
  id: TicketId
  fields: FieldSet
  jira?: JiraLink
  github?: GithubLink
  sync: SyncMeta
}

// ── Plan ────────────────────────────────────────────────────────────────────
// A plan is plain, serialisable data. The same object is printed for a human,
// emitted by `--json`, and executed by `--apply`, so the preview and the action
// cannot drift apart.

export interface ScalarChange {
  field: ScalarFieldName
  from: string | null
  to: string | null
  /**
   * True when the tracker cannot accept this as a plain field write. The core
   * states the requirement; resolving it (to a transition id, say) is the
   * adapter's problem.
   */
  viaTransition?: true
}

export interface LabelsChange {
  field: 'labels'
  add: string[]
  remove: string[]
}

export type FieldChange = ScalarChange | LabelsChange

export interface Conflict {
  field: FieldName
  base: string | string[] | null
  local: string | string[] | null
  remote: string | string[] | null
}

export interface TicketPlan {
  id: TicketId
  /** Changes to apply to the local file. */
  pull: FieldChange[]
  /** Changes to send to the tracker. */
  push: FieldChange[]
  conflicts: Conflict[]
  /**
   * True when nothing needs sending in either direction but the recorded base
   * snapshot is stale — both sides made the same change independently.
   */
  baseUpdateOnly: boolean
  /** Situations a human should look at, which the tool will not act on. */
  warnings: string[]
}

export interface SyncPlan {
  tickets: TicketPlan[]
  /** Tickets excluded by `--limit`. Never silently dropped. */
  withheld: number
}

export function isLabelsChange(c: FieldChange): c is LabelsChange {
  return c.field === 'labels'
}

/** True when a plan would neither read nor write anything. */
export function isEmptyPlan(p: TicketPlan): boolean {
  return (
    p.pull.length === 0 &&
    p.push.length === 0 &&
    p.conflicts.length === 0 &&
    !p.baseUpdateOnly
  )
}
