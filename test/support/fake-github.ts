/**
 * An in-process stand-in for the GitHub Issues REST API, on loopback.
 *
 * The Jira substitute exists so the tool can be *driven* without a real
 * instance. This one exists for a different reason: the external source is
 * read-only, and a guarantee like that is worth an adversary. So this server
 * does not merely serve issues — it refuses and records anything that is not a
 * GET, which turns "we never write to the client's repository" from a claim
 * about our code into an observation about the wire.
 *
 * It implements only what the adapter calls: `GET /repos/{owner}/{repo}/issues`
 * with `state`, `since`, `per_page`, pagination via the Link header, and
 * conditional requests via ETag. Anything else answers 404 rather than being
 * quietly faked — an unimplemented path should look like a missing endpoint,
 * not like an empty result.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface FakeIssueInput {
  number: number
  title: string
  body?: string
  state?: 'open' | 'closed'
  labels?: string[]
  author?: string
  createdAt?: string
  updatedAt?: string
  /** Set to mark the item a pull request; the adapter must skip it. */
  pullRequest?: boolean
}

export interface FakeGithubOptions {
  /** Issues per repo, keyed by "owner/repo". */
  repos?: Record<string, FakeIssueInput[]>
  /** Page size the server enforces, regardless of what the client asks for. */
  perPage?: number
  /** Token the server will accept. Anything else gets a 401. */
  token?: string
}

export class FakeGithub {
  private server: Server | null = null
  private base = ''

  private readonly repos = new Map<string, FakeIssueInput[]>()
  private readonly perPage: number
  readonly token: string

  /** Every request received, for asserting that a run wrote nothing. */
  readonly requests: { method: string; path: string }[] = []

  constructor(opts: FakeGithubOptions = {}) {
    this.perPage = opts.perPage ?? 100
    this.token = opts.token ?? 'fake-gh-token'
    for (const [slug, issues] of Object.entries(opts.repos ?? {})) {
      this.repos.set(slug, [...issues])
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const method = req.method ?? 'GET'
      const path = req.url ?? '/'
      this.requests.push({ method, path })

      // Drain the body so a writing client gets its rejection rather than a
      // socket error, which would be indistinguishable from a network fault.
      req.resume()

      if (method !== 'GET') {
        // 405 rather than 403: the objection is to the verb, not the caller.
        return send(res, 405, { message: `${method} is not allowed on this server` })
      }

      const [rawPath = '', query = ''] = path.split('?')
      const match = rawPath.match(/^\/repos\/([^/]+)\/([^/]+)\/issues$/)
      if (!match) return send(res, 404, { message: 'Not Found' })

      const auth = req.headers['authorization']
      if (auth !== undefined && auth !== `Bearer ${this.token}`) {
        return send(res, 401, { message: 'Bad credentials' })
      }

      const slug = `${match[1]}/${match[2]}`
      const issues = this.repos.get(slug)
      if (!issues) return send(res, 404, { message: 'Not Found' })

      const params = new URLSearchParams(query)
      const since = params.get('since')
      const state = params.get('state') ?? 'open'
      const page = Number(params.get('page') ?? '1')

      const selected = issues
        .filter((i) => state === 'all' || (i.state ?? 'open') === state)
        // `since` is inclusive of the boundary in the real API, and the cursor
        // logic depends on that: an exclusive bound here would hide the
        // off-by-one where an issue updated exactly at the cursor is dropped.
        .filter((i) => !since || (i.updatedAt ?? '') >= since)
        .sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? ''))

      const start = (page - 1) * this.perPage
      const slice = selected.slice(start, start + this.perPage)
      const hasMore = start + this.perPage < selected.length

      const headers: Record<string, string> = {
        // Weak-ish but stable: same content, same tag, so a second pass is a
        // 304 and the adapter's conditional-request path is actually taken.
        ETag: `"${slug}:${state}:${since ?? ''}:${page}:${selected.length}"`,
      }
      if (hasMore) {
        const next = new URLSearchParams(params)
        next.set('page', String(page + 1))
        headers['Link'] = `<${this.base}${rawPath}?${next.toString()}>; rel="next"`
      }

      if (req.headers['if-none-match'] === headers['ETag']) {
        res.writeHead(304, headers)
        return res.end()
      }

      send(res, 200, slice.map(serialise), headers)
    })

    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    const { port } = this.server!.address() as AddressInfo
    this.base = `http://127.0.0.1:${port}`
    return this.base
  }

  async stop(): Promise<void> {
    if (!this.server) return
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  get baseUrl(): string {
    return this.base
  }

  // ── inspection and control ────────────────────────────────────────────────

  /** True when every request received was a read. */
  wroteNothing(): boolean {
    return this.requests.every((r) => r.method === 'GET')
  }

  /** Edits an issue server-side, as a person would in the GitHub UI. */
  edit(slug: string, number: number, patch: Partial<FakeIssueInput>): void {
    const issues = this.repos.get(slug)
    const issue = issues?.find((i) => i.number === number)
    if (!issue) throw new Error(`no such issue ${slug}#${number}`)
    Object.assign(issue, patch)
  }
}

function serialise(i: FakeIssueInput): Record<string, unknown> {
  return {
    number: i.number,
    title: i.title,
    body: i.body ?? '',
    state: i.state ?? 'open',
    labels: (i.labels ?? []).map((name) => ({ name })),
    user: { login: i.author ?? 'alice' },
    created_at: i.createdAt ?? '2026-08-01T00:00:00Z',
    updated_at: i.updatedAt ?? '2026-08-01T00:00:00Z',
    ...(i.pullRequest ? { pull_request: { url: 'https://example.test/pull/1' } } : {}),
  }
}

function send(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
  res.end(payload)
}
