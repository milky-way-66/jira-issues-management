/**
 * TrackerPort backed by Jira Server / Data Center REST API v2.
 *
 * Specified by docs/testcase/integration/TC-I-jira-adapter.md.
 *
 * Everything Jira-specific stops here: wiki markup, `customfield_*` ids,
 * transitions, `name`-based user references. The core sees only `RemoteTicket`
 * and `FieldChange`.
 *
 * Jira Cloud is a *different* adapter: v3, ADF bodies, and `accountId` instead
 * of `name`. Sending one product's shape to the other fails outright, so this
 * file pins Server deliberately.
 */

import type { IdentityPort, TrackerPort } from '../core/ports.js'
import type {
  FieldChange,
  FieldSet,
  Instant,
  RemoteTicket,
  TicketDraft,
  TicketId,
} from '../core/ticket.js'
import { isLabelsChange } from '../core/ticket.js'
import { markdownToWiki, wikiToMarkdown } from './jira-wiki.js'
import { nonLoopbackUnderTest } from './test-guard.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface JiraOptions {
  baseUrl: string
  project: string
  token: string
  /** Discovered once by `mgmt doctor`; null when the instance has no Epic Link. */
  epicLinkField: string | null
  fetch?: FetchLike
  /** Injected so retry logic is testable without actually sleeping. */
  sleep?: (ms: number) => Promise<void>
  pageSize?: number
}

export class JiraError extends Error {}
export class JiraAuthError extends JiraError {}

/** Overlap applied to the cursor to absorb clock skew between hosts. */
export const SKEW_MS = 5 * 60 * 1000

export class JiraTracker implements TrackerPort, IdentityPort {
  private readonly fetch: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pageSize: number

  constructor(private readonly opts: JiraOptions) {
    assertSafeHost(opts.baseUrl)
    this.fetch = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.pageSize = opts.pageSize ?? 50
  }

  async *fetchUpdatedSince(cursor: Instant | null): AsyncIterable<RemoteTicket> {
    const jql = buildJql(this.opts.project, cursor)
    let startAt = 0

    for (;;) {
      const page = (await this.request(
        `/rest/api/2/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=${this.pageSize}`,
      )) as { issues?: unknown[]; total?: number }

      const issues = page.issues ?? []
      for (const raw of issues) yield this.toRemoteTicket(raw)

      startAt += issues.length
      if (issues.length === 0 || startAt >= (page.total ?? 0)) break
    }
  }

  async fetchOne(id: TicketId): Promise<RemoteTicket | null> {
    try {
      return this.toRemoteTicket(await this.request(`/rest/api/2/issue/${encodeURIComponent(id)}`))
    } catch (err) {
      if (err instanceof JiraError && /\b404\b/.test(err.message)) return null
      throw err
    }
  }

  async findBySyncLabel(localId: string): Promise<TicketId | null> {
    const jql = `project = "${this.opts.project}" AND labels = "sync-${localId}"`
    const page = (await this.request(
      `/rest/api/2/search?jql=${encodeURIComponent(jql)}&maxResults=1&fields=key`,
    )) as { issues?: { key?: string }[] }

    return page.issues?.[0]?.key ?? null
  }

  async create(draft: TicketDraft): Promise<TicketId> {
    const body = {
      fields: {
        project: { key: this.opts.project },
        summary: draft.fields.title,
        description: markdownToWiki(draft.fields.body),
        issuetype: { name: draft.fields.type },
        labels: draft.fields.labels,
        ...(draft.fields.parent && this.opts.epicLinkField
          ? { [this.opts.epicLinkField]: draft.fields.parent }
          : {}),
      },
    }

    const created = (await this.request('/rest/api/2/issue', {
      method: 'POST',
      body: JSON.stringify(body),
    })) as { key?: string }

    if (!created.key) throw new JiraError('create succeeded but returned no issue key')
    return created.key
  }

  async applyChanges(id: TicketId, changes: readonly FieldChange[]): Promise<void> {
    const fields: Record<string, unknown> = {}
    const update: Record<string, unknown> = {}
    const transitions: FieldChange[] = []

    for (const change of changes) {
      if (isLabelsChange(change)) {
        // Add/remove operations, never a whole-array replacement — replacing
        // discards labels other people or automation added between syncs.
        const ops = [
          ...change.add.map((v) => ({ add: v })),
          ...change.remove.map((v) => ({ remove: v })),
        ]
        if (ops.length > 0) update['labels'] = ops
        continue
      }

      if (change.viaTransition) {
        transitions.push(change)
        continue
      }

      switch (change.field) {
        case 'title':
          fields['summary'] = change.to
          break
        case 'body':
          fields['description'] = change.to === null ? null : markdownToWiki(change.to)
          break
        case 'assignee':
          // Server uses `name`. `accountId` is Cloud and would fail here.
          fields['assignee'] = change.to === null ? null : { name: change.to }
          break
        case 'priority':
          fields['priority'] = change.to === null ? null : { name: change.to }
          break
        case 'due':
          fields['duedate'] = change.to
          break
        case 'estimate':
          fields['timetracking'] = { originalEstimate: change.to }
          break
        case 'parent':
          if (this.opts.epicLinkField) fields[this.opts.epicLinkField] = change.to
          break
        case 'type':
          throw new JiraError('issue type is never changed automatically')
        case 'status':
          transitions.push(change)
          break
      }
    }

    if (Object.keys(fields).length > 0 || Object.keys(update).length > 0) {
      await this.request(`/rest/api/2/issue/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({
          ...(Object.keys(fields).length > 0 ? { fields } : {}),
          ...(Object.keys(update).length > 0 ? { update } : {}),
        }),
      })
    }

    for (const t of transitions) {
      if (isLabelsChange(t)) continue
      await this.transition(id, t.to)
    }
  }

  /**
   * Status moves through the workflow, not through a field write. Transition
   * ids are instance-specific, so the name is resolved here rather than in the
   * core.
   */
  private async transition(id: TicketId, statusName: string | null): Promise<void> {
    if (statusName === null) throw new JiraError('cannot transition to an empty status')

    const available = (await this.request(
      `/rest/api/2/issue/${encodeURIComponent(id)}/transitions`,
    )) as { transitions?: { id?: string; name?: string; to?: { name?: string } }[] }

    const list = available.transitions ?? []
    const match = list.find(
      (t) => t.to?.name?.toLowerCase() === statusName.toLowerCase() ||
        t.name?.toLowerCase() === statusName.toLowerCase(),
    )

    if (!match?.id) {
      const names = list.map((t) => t.to?.name ?? t.name).filter(Boolean).join(', ')
      throw new JiraError(
        `${id}: no transition to "${statusName}". Available: ${names || '(none)'}`,
      )
    }

    await this.request(`/rest/api/2/issue/${encodeURIComponent(id)}/transitions`, {
      method: 'POST',
      body: JSON.stringify({ transition: { id: match.id } }),
    })
  }

  async serverInfo(): Promise<{ version: string; deploymentType: string }> {
    const info = (await this.request('/rest/api/2/serverInfo')) as {
      version?: string
      deploymentType?: string
    }
    return {
      version: info.version ?? 'unknown',
      deploymentType: info.deploymentType ?? 'unknown',
    }
  }

  /**
   * The username the token belongs to.
   *
   * `name` is the Server/Data Center field; `key` is the fallback on instances
   * that only expose that. Not `accountId` — this is not Jira Cloud, and an
   * assignee in these files is a username.
   */
  async whoAmI(): Promise<string | null> {
    const me = (await this.request('/rest/api/2/myself')) as { name?: string; key?: string }
    return me.name ?? me.key ?? null
  }

  /** Finds the Epic Link custom field id so it never has to be guessed. */
  async discoverEpicLinkField(): Promise<string | null> {
    const fields = (await this.request('/rest/api/2/field')) as {
      id?: string
      name?: string
      custom?: boolean
    }[]
    return fields.find((f) => f.custom && f.name === 'Epic Link')?.id ?? null
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  private async request(path: string, init: RequestInit = {}, attempt = 0): Promise<unknown> {
    const res = await this.fetch(`${this.opts.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
    })

    if (res.status === 401 || res.status === 403) {
      throw new JiraAuthError(
        `Jira rejected the credentials (HTTP ${res.status}). Check JIRA_PAT.`,
      )
    }

    if (res.status === 429 && attempt < 3) {
      const retryAfter = Number(res.headers.get('Retry-After') ?? '1')
      await this.sleep(Math.max(retryAfter, 1) * 1000 * (attempt + 1))
      return this.request(path, init, attempt + 1)
    }

    if (!res.ok) {
      throw new JiraError(`Jira request failed: HTTP ${res.status} for ${path}`)
    }

    if (res.status === 204) return {}

    const text = await res.text()
    if (text.trim() === '') return {}
    try {
      return JSON.parse(text)
    } catch {
      throw new JiraError(`Jira returned a malformed response for ${path}`)
    }
  }

  // ── Mapping ───────────────────────────────────────────────────────────────

  toRemoteTicket(raw: unknown): RemoteTicket {
    const issue = raw as { key?: string; fields?: Record<string, unknown> }
    const key = issue.key
    if (!key) throw new JiraError('issue is missing its key')

    const f = issue.fields ?? {}

    const parent =
      (this.opts.epicLinkField ? asString(f[this.opts.epicLinkField]) : null) ??
      asString((f['parent'] as { key?: string } | undefined)?.key)

    const fields: FieldSet = {
      title: asString(f['summary']) ?? '',
      body: wikiToMarkdown(asString(f['description']) ?? ''),
      status: asString((f['status'] as { name?: string } | undefined)?.name) ?? '',
      assignee: asString((f['assignee'] as { name?: string } | undefined)?.name),
      type: asString((f['issuetype'] as { name?: string } | undefined)?.name) ?? '',
      parent,
      labels: Array.isArray(f['labels']) ? (f['labels'] as unknown[]).map(String) : [],
      priority: asString((f['priority'] as { name?: string } | undefined)?.name),
      estimate: asString(
        (f['timetracking'] as { originalEstimate?: string } | undefined)?.originalEstimate,
      ),
      due: asString(f['duedate']),
    }

    return { key, fields, updated: asString(f['updated']) ?? '' }
  }
}

/** Absent, null and empty all mean "no value" — never the string "null". */
function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v)
  return s.trim() === '' ? null : s
}

export function buildJql(project: string, cursor: Instant | null): string {
  const base = `project = "${project}"`
  if (!cursor) return `${base} ORDER BY updated ASC`

  const since = new Date(new Date(cursor).getTime() - SKEW_MS)
  return `${base} AND updated >= "${formatJqlDate(since)}" ORDER BY updated ASC`
}

/** Jira expects `yyyy/MM/dd HH:mm` in the server's own timezone. */
function formatJqlDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Refuses to contact anything but loopback while tests are running.
 *
 * The failure this prevents — a test run pointed at a live instance — is
 * expensive and irreversible, and it is exactly the kind of mistake that
 * happens once, at speed, on someone's laptop.
 */
export function assertSafeHost(baseUrl: string): void {
  const message = nonLoopbackUnderTest(baseUrl, 'tracker')
  if (message) throw new JiraError(message)
}
