/**
 * Builds a Kanban view of the workspace from the ticket files alone.
 *
 * No network. Every value on a card was already pulled from the tracker and
 * written to disk by a sync, so the board is a projection of local state — it
 * works on a plane, and it can never show something the files do not say.
 *
 * Two views over the same cards: the whole project, and the tickets assigned to
 * one person. They are built together because they must agree; a card missing
 * from "mine" but present in "project" is a bug, not a filter.
 */

import type { Instant, Ticket } from '../ticket.js'

export interface BoardCard {
  id: string
  title: string
  type: string
  status: string
  assignee: string | null
  priority: string | null
  parent: string | null
  labels: string[]
  /** Path to the ticket file, relative to the workspace root. */
  path: string
  /** The tracker's own URL, when the ticket has been pushed. */
  url: string | null
  /** Whether the last sync left this ticket conflicted. */
  conflict: boolean
}

export interface BoardColumn {
  status: string
  cards: BoardCard[]
}

export interface BoardView {
  key: 'project' | 'mine'
  title: string
  columns: BoardColumn[]
  total: number
}

export interface Board {
  project: BoardView
  mine: BoardView
  /** Whose board "mine" is, or null when the identity could not be resolved. */
  me: string | null
  generated: Instant
  /** Column order, shared by both views so they line up side by side. */
  columns: string[]
}

export interface BoardOptions {
  me: string | null
  generated: Instant
  /**
   * Explicit column order. Statuses listed here come first, in this order, and
   * are rendered even when empty; anything else is appended by the ordering
   * below. This is the escape hatch for a workflow whose names we cannot rank.
   */
  order?: readonly string[]
  /**
   * Builds a link to a ticket in the tracker, used when the file does not carry
   * one of its own. Injected rather than assembled here: the shape of that URL
   * is the tracker's business, and the core has never known a hostname.
   */
  browseUrl?: (key: string) => string | null
}

/**
 * How far along a status is, by name.
 *
 * The status *names* come from the tracker — they are whatever it wrote into
 * the files, never invented here. Their *order* does not, because a ticket
 * records the status it is in and nothing about the workflow it belongs to.
 * Rather than ask the tracker (a network call, for a command that otherwise
 * needs none), rank the names we can recognise and leave the rest alone.
 *
 * An unrecognised status ranks between "active" and "done": in the middle,
 * where a stray column is visible rather than buried past Done. Use `--columns`
 * when that guess is wrong — it is a guess, and it says so.
 */
const RANK: readonly [RegExp, number][] = [
  [/^(backlog|to.?do|open|new|created|reopened)$/i, 0],
  [/^(selected for development|ready|ready for development|approved)$/i, 1],
  [/^(in progress|doing|in development|implementing)$/i, 2],
  [/^(in review|review|code review|in qa|qa|testing|in test|verifying)$/i, 3],
  [/^(blocked|on hold|waiting|pending|impeded)$/i, 4],
  [/^(done|closed|resolved|complete|completed|cancelled|canceled|won'?t do|won'?t fix)$/i, 6],
]

const UNKNOWN_RANK = 5

export function rankOf(status: string): number {
  for (const [pattern, rank] of RANK) if (pattern.test(status.trim())) return rank
  return UNKNOWN_RANK
}

/** Numeric part of `PROJ-12` / `LOCAL-0007`, for a stable, human order. */
function idOrder(id: string): number {
  const n = /-(\d+)$/.exec(id)
  return n ? Number(n[1]) : Number.MAX_SAFE_INTEGER
}

/**
 * A ticket's own link, falling back to one built from its key.
 *
 * Tickets pulled before this existed carry an empty `url`, so a card that could
 * link to the tracker would silently not — hence the fallback rather than a
 * migration of every file.
 */
function urlOf(ticket: Ticket, build: BoardOptions['browseUrl']): string | null {
  const own = ticket.jira?.url
  if (own) return own
  const key = ticket.jira?.key
  return key && build ? build(key) : null
}

function cardOf(ticket: Ticket, opts: BoardOptions): BoardCard {
  return {
    id: ticket.id,
    title: ticket.fields.title,
    type: ticket.fields.type,
    status: ticket.fields.status,
    assignee: ticket.fields.assignee,
    priority: ticket.fields.priority,
    parent: ticket.fields.parent,
    labels: [...ticket.fields.labels],
    path: `tickets/${ticket.id}.md`,
    url: urlOf(ticket, opts.browseUrl),
    conflict: ticket.sync.conflict,
  }
}

/**
 * Column order: explicit names first, then everything else by rank, ties broken
 * by first appearance so the order is stable across runs on unchanged data.
 */
function orderColumns(statuses: readonly string[], explicit: readonly string[]): string[] {
  const seen = new Map<string, number>()
  for (const s of statuses) if (!seen.has(s)) seen.set(s, seen.size)

  const pinned = explicit.filter((s, i) => explicit.indexOf(s) === i)
  const rest = [...seen.keys()].filter((s) => !pinned.some((p) => eqStatus(p, s)))

  rest.sort((a, b) => {
    const byRank = rankOf(a) - rankOf(b)
    return byRank !== 0 ? byRank : (seen.get(a) ?? 0) - (seen.get(b) ?? 0)
  })

  return [...pinned, ...rest]
}

function eqStatus(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function viewOf(
  key: BoardView['key'],
  title: string,
  cards: readonly BoardCard[],
  columns: readonly string[],
): BoardView {
  return {
    key,
    title,
    columns: columns.map((status) => ({
      status,
      cards: cards
        .filter((c) => eqStatus(c.status, status))
        .sort((a, b) => idOrder(a.id) - idOrder(b.id)),
    })),
    total: cards.length,
  }
}

/** Case-insensitive, because a tracker's own casing of a username varies. */
export function isMine(card: BoardCard, me: string | null): boolean {
  if (me === null || card.assignee === null) return false
  return card.assignee.trim().toLowerCase() === me.trim().toLowerCase()
}

export function buildBoard(tickets: readonly Ticket[], opts: BoardOptions): Board {
  const cards = tickets.map((t) => cardOf(t, opts))
  const columns = orderColumns(
    cards.map((c) => c.status),
    opts.order ?? [],
  )

  return {
    project: viewOf('project', 'Project tasks', cards, columns),
    mine: viewOf('mine', 'My tasks', cards.filter((c) => isMine(c, opts.me)), columns),
    me: opts.me,
    generated: opts.generated,
    columns,
  }
}
