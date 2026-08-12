/**
 * An in-process stand-in for Jira Server / Data Center REST API v2.
 *
 * Purpose: make the whole tool runnable end to end without a real instance, a
 * real credential, or a network. It listens on loopback only, so it satisfies
 * the same safety rule the adapter enforces.
 *
 * It implements the subset the adapter actually calls, and it models the two
 * behaviours that matter for correctness:
 *
 *   - `updated` advances on every write, so cursor logic is exercised for real
 *     rather than against a frozen fixture.
 *   - status moves only through a declared transition, so a workflow that
 *     forbids a jump fails here exactly as it would in production.
 *
 * It is deliberately *not* a Jira emulator. Anything beyond the adapter's
 * surface should fail loudly rather than be quietly faked.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeIssue {
  key: string
  fields: Record<string, unknown>
}

export interface FakeTransition {
  id: string
  name: string
  to: string
}

export interface FakeJiraOptions {
  project?: string
  epicLinkField?: string
  /** Transitions offered for every issue. Defaults to a simple three-state flow. */
  transitions?: FakeTransition[]
  /** Token the server will accept. Anything else gets a 401. */
  token?: string
  /** Username `/myself` reports for that token. */
  me?: string
}

const DEFAULT_TRANSITIONS: FakeTransition[] = [
  { id: '11', name: 'To Do', to: 'To Do' },
  { id: '21', name: 'Start Progress', to: 'In Progress' },
  { id: '31', name: 'Done', to: 'Done' },
]

export class FakeJira {
  private server: Server | null = null
  private issues = new Map<string, FakeIssue>()
  private counter = 0
  private clock = Date.parse('2026-08-11T09:00:00+09:00')

  readonly project: string
  readonly epicLinkField: string
  readonly token: string
  readonly me: string
  private readonly transitions: FakeTransition[]

  /** Every request received, for asserting that a run wrote nothing. */
  readonly requests: { method: string; path: string; body: unknown }[] = []

  constructor(opts: FakeJiraOptions = {}) {
    this.project = opts.project ?? 'PROJ'
    this.epicLinkField = opts.epicLinkField ?? 'customfield_10014'
    this.token = opts.token ?? 'fake-token'
    this.me = opts.me ?? 'alice'
    this.transitions = opts.transitions ?? DEFAULT_TRANSITIONS
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        let parsed: unknown
        try {
          parsed = raw === '' ? undefined : JSON.parse(raw)
        } catch {
          res.writeHead(400).end('{"errorMessages":["bad json"]}')
          return
        }

        const path = req.url ?? '/'
        this.requests.push({ method: req.method ?? 'GET', path, body: parsed })

        if (req.headers.authorization !== `Bearer ${this.token}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ errorMessages: ['unauthorised'] }))
          return
        }

        try {
          const result = this.route(req.method ?? 'GET', path, parsed)
          res.writeHead(result.status, { 'Content-Type': 'application/json' })
          res.end(result.body === undefined ? '' : JSON.stringify(result.body))
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ errorMessages: [(err as Error).message] }))
        }
      })
    })

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server!.address() as AddressInfo
    return `http://127.0.0.1:${port}`
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  // ── seeding and inspection ────────────────────────────────────────────────

  /** Adds an issue directly, bypassing the API, to set up a scenario. */
  seed(fields: Partial<Record<string, unknown>> & { summary: string }, key?: string): string {
    const issueKey = key ?? `${this.project}-${++this.counter}`
    this.issues.set(issueKey, {
      key: issueKey,
      fields: {
        summary: fields['summary'],
        description: fields['description'] ?? '',
        status: { name: fields['status'] ?? 'To Do' },
        assignee: fields['assignee'] ? { name: fields['assignee'] } : null,
        issuetype: { name: fields['issuetype'] ?? 'Task' },
        labels: fields['labels'] ?? [],
        priority: fields['priority'] ? { name: fields['priority'] } : null,
        duedate: fields['duedate'] ?? null,
        updated: this.tick(),
        ...(fields['parent'] ? { [this.epicLinkField]: fields['parent'] } : {}),
      },
    })
    return issueKey
  }

  get(key: string): FakeIssue | undefined {
    return this.issues.get(key)
  }

  /** True when the run never attempted a write — the safety assertion for pull. */
  wroteNothing(): boolean {
    return this.requests.every((r) => r.method === 'GET')
  }

  /** Simulates someone editing the issue in the browser between syncs. */
  edit(key: string, fields: Record<string, unknown>): void {
    const issue = this.issues.get(key)
    if (!issue) throw new Error(`no such issue: ${key}`)
    Object.assign(issue.fields, fields, { updated: this.tick() })
  }

  /** Moves the substitute's clock forward, so timestamp gaps can be made explicit. */
  advance(minutes: number): void {
    this.clock += minutes * 60_000
  }

  /** The instant the next write will stamp. */
  now(): string {
    return new Date(this.clock).toISOString()
  }

  private tick(): string {
    this.clock += 60_000
    return new Date(this.clock).toISOString()
  }

  // ── routing ───────────────────────────────────────────────────────────────

  private route(
    method: string,
    url: string,
    body: unknown,
  ): { status: number; body?: unknown } {
    const [path, query] = url.split('?')
    const params = new URLSearchParams(query ?? '')

    if (path === '/rest/api/2/serverInfo') {
      return { status: 200, body: { version: '9.12.0', deploymentType: 'Server' } }
    }

    if (path === '/rest/api/2/myself') {
      return { status: 200, body: { name: this.me, key: this.me, displayName: this.me } }
    }

    if (path === '/rest/api/2/field') {
      return {
        status: 200,
        body: [
          { id: 'summary', name: 'Summary', custom: false },
          { id: this.epicLinkField, name: 'Epic Link', custom: true },
        ],
      }
    }

    if (path === '/rest/api/2/search') {
      return { status: 200, body: this.search(params) }
    }

    if (path === '/rest/api/2/issue' && method === 'POST') {
      return { status: 201, body: this.create(body) }
    }

    const issueMatch = path?.match(/^\/rest\/api\/2\/issue\/([^/]+)(\/transitions)?$/)
    if (issueMatch) {
      const key = decodeURIComponent(issueMatch[1]!)
      const issue = this.issues.get(key)
      if (!issue) return { status: 404, body: { errorMessages: [`issue ${key} not found`] } }

      if (issueMatch[2]) {
        return method === 'POST'
          ? this.applyTransition(issue, body)
          : { status: 200, body: { transitions: this.transitions.map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })) } }
      }

      if (method === 'GET') return { status: 200, body: issue }
      if (method === 'PUT') return this.update(issue, body)
    }

    return { status: 404, body: { errorMessages: [`unhandled: ${method} ${path}`] } }
  }

  private search(params: URLSearchParams): unknown {
    const jql = params.get('jql') ?? ''
    const startAt = Number(params.get('startAt') ?? '0')
    const maxResults = Number(params.get('maxResults') ?? '50')

    let matches = [...this.issues.values()]

    const label = jql.match(/labels = "([^"]+)"/)?.[1]
    if (label) {
      matches = matches.filter((i) => (i.fields['labels'] as string[]).includes(label))
    }

    const since = jql.match(/updated >= "([^"]+)"/)?.[1]
    if (since) {
      // JQL dates carry no zone: Jira reads them in the server's own timezone,
      // which is what the adapter formats them in. Parsing as UTC here would
      // silently shift the bound by the offset and hide cursor bugs.
      const bound = Date.parse(since.replace(/(\d{4})\/(\d{2})\/(\d{2}) /, '$1-$2-$3T') + ':00')
      matches = matches.filter((i) => Date.parse(String(i.fields['updated'])) >= bound)
    }

    matches.sort((a, b) => String(a.fields['updated']).localeCompare(String(b.fields['updated'])))

    return {
      total: matches.length,
      startAt,
      issues: matches.slice(startAt, startAt + maxResults),
    }
  }

  private create(body: unknown): unknown {
    const fields = (body as { fields?: Record<string, unknown> }).fields ?? {}
    const key = this.seed(
      {
        summary: String(fields['summary'] ?? ''),
        description: fields['description'],
        issuetype: (fields['issuetype'] as { name?: string })?.name,
        labels: fields['labels'],
        parent: fields[this.epicLinkField],
      },
    )
    return { id: key, key, self: `/rest/api/2/issue/${key}` }
  }

  private update(issue: FakeIssue, body: unknown): { status: number; body?: unknown } {
    const req = body as {
      fields?: Record<string, unknown>
      update?: Record<string, { add?: string; remove?: string }[]>
    }

    if (req.fields && 'status' in req.fields) {
      // Jira rejects this too: status is a workflow move, not a field write.
      return { status: 400, body: { errorMessages: ['Field "status" cannot be set directly'] } }
    }

    Object.assign(issue.fields, req.fields ?? {})

    for (const op of req.update?.['labels'] ?? []) {
      const labels = new Set(issue.fields['labels'] as string[])
      if (op.add) labels.add(op.add)
      if (op.remove) labels.delete(op.remove)
      issue.fields['labels'] = [...labels].sort()
    }

    issue.fields['updated'] = this.tick()
    return { status: 204 }
  }

  private applyTransition(issue: FakeIssue, body: unknown): { status: number; body?: unknown } {
    const id = (body as { transition?: { id?: string } })?.transition?.id
    const match = this.transitions.find((t) => t.id === id)
    if (!match) {
      return { status: 400, body: { errorMessages: [`transition ${id} is not available`] } }
    }

    issue.fields['status'] = { name: match.to }
    issue.fields['updated'] = this.tick()
    return { status: 204 }
  }
}
