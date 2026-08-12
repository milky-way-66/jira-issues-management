/**
 * Every port the core declares. Adapters implement these; the core never
 * imports an adapter.
 *
 * Ports speak business language. If one of these ever starts to look like the
 * shape of a REST payload, the hexagon has stopped doing its job — swapping a
 * provider would break the core anyway.
 */

import type {
  ExternalIssue,
  FieldChange,
  Instant,
  RemoteTicket,
  Ticket,
  TicketDraft,
  TicketId,
} from './ticket.js'

/** The tracker of record. Jira sits behind this. */
export interface TrackerPort {
  fetchUpdatedSince(cursor: Instant | null): AsyncIterable<RemoteTicket>
  fetchOne(id: TicketId): Promise<RemoteTicket | null>
  create(draft: TicketDraft): Promise<TicketId>
  applyChanges(id: TicketId, changes: FieldChange[]): Promise<void>
  /**
   * Finds a ticket previously created for `localId`, identified by the
   * `sync-<localId>` label attached at creation time.
   *
   * This is what makes creation recoverable: if the process died after the
   * tracker created the issue but before the key was written locally, the next
   * run adopts it instead of creating a duplicate.
   */
  findBySyncLabel(localId: string): Promise<TicketId | null>
}

/**
 * The external issue source. GitHub sits behind this.
 *
 * Deliberately has no write methods: "we never write to the customer's
 * repository" is a guarantee about someone else's system, so it is expressed in
 * the type system rather than left to code review.
 */
export interface IssueSourcePort {
  fetchUpdatedSince(cursor: Instant | null): AsyncIterable<ExternalIssue>
  /** Full scan, used to reconcile deletions an incremental query cannot see. */
  fetchAll(): AsyncIterable<ExternalIssue>
}

/** The workspace on disk: ticket files, base snapshots, cursors. */
export interface TicketRepoPort {
  list(): Promise<TicketId[]>
  load(id: TicketId): Promise<Ticket | null>
  save(ticket: Ticket): Promise<void>
  /** Moves out of the working set. Never deletes. */
  archive(id: TicketId): Promise<void>

  /** The remote state at the last successful sync — input to the merge. */
  readBase(id: TicketId): Promise<RemoteTicket | null>
  writeBase(id: TicketId, snapshot: RemoteTicket): Promise<void>

  getCursor(key: string): Promise<Instant | null>
  setCursor(key: string, value: Instant): Promise<void>

  /** Highest allocated local id, including archived tickets. */
  highestLocalId(): Promise<number>
}

/**
 * What `mgmt doctor` needs to ask the tracker. Kept apart from `TrackerPort`
 * because sync must not depend on it: an instance can be perfectly syncable
 * while refusing to expose its field catalogue.
 */
export interface TrackerHealthPort {
  serverInfo(): Promise<{ version: string; deploymentType: string }>
  /** Resolves the Epic Link custom field id, or null if the instance has none. */
  discoverEpicLinkField(): Promise<string | null>
}

/** Injected so tests can pin time and never sleep. */
export interface ClockPort {
  now(): Instant
}
