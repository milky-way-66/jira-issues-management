/**
 * TicketRepoPort backed by Markdown files with YAML frontmatter.
 *
 * Specified by docs/testcase/integration/TC-I-markdown-repo.md.
 *
 * Two properties matter more than they look:
 *
 *   - Serialisation is *stable*. Loading and saving without editing must produce
 *     identical bytes, or a scheduled sync commits noise forever and real
 *     changes become invisible in the history.
 *   - Base snapshots are written atomically. A truncated snapshot is worse than
 *     a missing one: it may parse yet describe a state that never existed,
 *     which corrupts the next merge.
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { TicketRepoPort } from '../core/ports.js'
import type {
  FieldSet,
  GithubLink,
  Instant,
  JiraLink,
  RemoteTicket,
  Ticket,
  TicketId,
} from '../core/ticket.js'

const TICKETS = 'tickets'
const ARCHIVE = 'archive'
const SYNC = '.sync'
const BASE = join(SYNC, 'base')
const STATE = join(SYNC, 'state.json')

/**
 * Frontmatter key order is fixed. Object key order is an implementation detail
 * of whatever built the object; without pinning it here, two logically equal
 * tickets serialise differently and every save churns the file.
 */
const KEY_ORDER = [
  'id',
  'title',
  'type',
  'status',
  'assignee',
  'parent',
  'labels',
  'priority',
  'estimate',
  'due',
  'jira',
  'github',
  'sync',
] as const

export class TicketFormatError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`)
  }
}

export class MarkdownTicketRepo implements TicketRepoPort {
  constructor(private readonly root: string) {}

  private ticketPath(id: TicketId): string {
    return join(this.root, TICKETS, `${id}.md`)
  }

  private archivePath(id: TicketId): string {
    return join(this.root, ARCHIVE, `${id}.md`)
  }

  private basePath(id: TicketId, dir: string = BASE): string {
    return join(this.root, dir, `${id}.json`)
  }

  async list(): Promise<TicketId[]> {
    const names = await safeReaddir(join(this.root, TICKETS))
    return names
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.slice(0, -3))
      .sort() // deterministic: snapshot output must not depend on inode order
  }

  async load(id: TicketId): Promise<Ticket | null> {
    const path = this.ticketPath(id)
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return null
    }
    return parseTicket(path, text)
  }

  async save(ticket: Ticket): Promise<void> {
    await mkdir(join(this.root, TICKETS), { recursive: true })
    await writeFile(this.ticketPath(ticket.id), serialiseTicket(ticket), 'utf8')
  }

  /** Moves out of the working set. Never deletes — git history is not a backup plan. */
  async archive(id: TicketId): Promise<void> {
    const from = this.ticketPath(id)
    await mkdir(join(this.root, ARCHIVE), { recursive: true })
    await rename(from, this.archivePath(id))

    // The snapshot travels with the ticket, so restoring it later still has a
    // merge base to work from.
    const baseFrom = this.basePath(id)
    try {
      await mkdir(join(this.root, SYNC, 'archive'), { recursive: true })
      await rename(baseFrom, this.basePath(id, join(SYNC, 'archive')))
    } catch {
      /* a ticket that never synced has no snapshot */
    }
  }

  async readBase(id: TicketId): Promise<RemoteTicket | null> {
    try {
      return JSON.parse(await readFile(this.basePath(id), 'utf8')) as RemoteTicket
    } catch {
      return null
    }
  }

  async writeBase(id: TicketId, snapshot: RemoteTicket): Promise<void> {
    await mkdir(join(this.root, BASE), { recursive: true })
    await writeAtomic(this.basePath(id), JSON.stringify(snapshot, null, 2) + '\n')
  }

  async getCursor(key: string): Promise<Instant | null> {
    const state = await this.readState()
    return state[key] ?? null
  }

  async setCursor(key: string, value: Instant): Promise<void> {
    const state = await this.readState()
    state[key] = value
    await mkdir(join(this.root, SYNC), { recursive: true })
    await writeAtomic(join(this.root, STATE), JSON.stringify(state, null, 2) + '\n')
  }

  private async readState(): Promise<Record<string, Instant>> {
    try {
      return JSON.parse(await readFile(join(this.root, STATE), 'utf8')) as Record<string, Instant>
    } catch {
      return {}
    }
  }

  /**
   * Includes archived tickets. Reusing an archived id would make the
   * duplicate-protection label point at the wrong remote issue.
   */
  async highestLocalId(): Promise<number> {
    const dirs = [join(this.root, TICKETS), join(this.root, ARCHIVE)]
    let highest = 0
    for (const dir of dirs) {
      for (const name of await safeReaddir(dir)) {
        const m = name.match(/^LOCAL-(\d+)\.md$/)
        if (m) highest = Math.max(highest, Number(m[1]))
      }
    }
    return highest
  }
}

// ── Serialisation ───────────────────────────────────────────────────────────

const DELIMITER = '---'

export function serialiseTicket(ticket: Ticket): string {
  const front: Record<string, unknown> = {
    id: ticket.id,
    title: ticket.fields.title,
    type: ticket.fields.type,
    status: ticket.fields.status,
    assignee: ticket.fields.assignee,
    parent: ticket.fields.parent,
    labels: ticket.fields.labels,
    priority: ticket.fields.priority,
    estimate: ticket.fields.estimate,
    due: ticket.fields.due,
  }
  if (ticket.jira) front['jira'] = ticket.jira
  if (ticket.github) front['github'] = ticket.github
  front['sync'] = {
    base: ticket.sync.base,
    last_pull: ticket.sync.lastPull,
    last_push: ticket.sync.lastPush,
    conflict: ticket.sync.conflict,
  }

  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    if (key in front) ordered[key] = front[key]
  }

  const yaml = stringifyYaml(ordered, {
    lineWidth: 0, // never fold: a wrapped Japanese title is unreadable in a diff
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  })

  const body = ticket.fields.body.replace(/\s*$/, '')
  return `${DELIMITER}\n${yaml}${DELIMITER}\n\n${body}\n`
}

export function parseTicket(file: string, text: string): Ticket {
  const normalised = text.replace(/\r\n/g, '\n')
  if (!normalised.startsWith(`${DELIMITER}\n`)) {
    throw new TicketFormatError(file, 'missing YAML frontmatter')
  }

  // Only the *first* closing delimiter at column 0 ends the frontmatter, so a
  // body containing `---` (a horizontal rule, or conflict markers) is safe.
  const end = normalised.indexOf(`\n${DELIMITER}\n`, DELIMITER.length)
  if (end === -1) throw new TicketFormatError(file, 'unterminated YAML frontmatter')

  const yamlText = normalised.slice(DELIMITER.length + 1, end + 1)
  const body = normalised.slice(end + DELIMITER.length + 2).replace(/^\n+/, '').replace(/\s*$/, '')

  let front: Record<string, unknown>
  try {
    front = (parseYaml(yamlText) ?? {}) as Record<string, unknown>
  } catch (err) {
    throw new TicketFormatError(file, `invalid YAML: ${(err as Error).message}`)
  }

  const required = ['id', 'title', 'type', 'status'] as const
  for (const key of required) {
    if (front[key] === undefined || front[key] === null || front[key] === '') {
      throw new TicketFormatError(file, `missing required field "${key}"`)
    }
  }

  const sync = (front['sync'] ?? {}) as Record<string, unknown>

  const fields: FieldSet = {
    title: String(front['title']),
    body,
    status: String(front['status']),
    assignee: asNullableString(front['assignee']),
    type: String(front['type']),
    parent: asNullableString(front['parent']),
    labels: Array.isArray(front['labels']) ? front['labels'].map(String) : [],
    priority: asNullableString(front['priority']),
    estimate: asNullableString(front['estimate']),
    due: asNullableString(front['due']),
  }

  const ticket: Ticket = {
    id: String(front['id']),
    fields,
    sync: {
      base: asNullableString(sync['base']),
      lastPull: asNullableString(sync['last_pull']),
      lastPush: asNullableString(sync['last_push']),
      conflict: sync['conflict'] === true,
    },
  }

  if (front['jira']) ticket.jira = front['jira'] as JiraLink
  if (front['github']) ticket.github = front['github'] as GithubLink
  return ticket
}

function asNullableString(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const s = String(v)
  return s.trim() === '' ? null : s
}

// ── Filesystem helpers ──────────────────────────────────────────────────────

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/** Write to a sibling temp file, then rename — rename is atomic on POSIX. */
async function writeAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp`
  try {
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}
