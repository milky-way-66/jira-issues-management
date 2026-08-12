/**
 * IssueSourcePort backed by the GitHub Issues REST API. **Read-only.**
 *
 * Specified by docs/testcase/integration/TC-I-github-adapter.md.
 *
 * This adapter talks to someone else's repository. "We never write to it" is
 * therefore a guarantee, not a preference, and it is expressed structurally:
 * the class implements `IssueSourcePort`, which declares no write method, and
 * the single request helper hard-codes GET. There is no code path here that
 * could issue a POST even if a caller asked for one.
 *
 * The port is also the reason nothing above this file mentions GitHub. Another
 * source — a different tracker, a CSV export, an internal ticket system — is a
 * new file next to this one, not a change to the core.
 */

import type { IssueSourcePort } from '../core/ports.js'
import type { ExternalIssue, Instant } from '../core/ticket.js'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface GithubRepo {
  owner: string
  repo: string
}

export interface GithubOptions {
  repos: readonly GithubRepo[]
  /** Optional: public repositories need no token, private ones do. */
  token?: string | undefined
  baseUrl?: string
  fetch?: FetchLike
  /** Injected so rate-limit backoff is testable without actually waiting. */
  sleep?: (ms: number) => Promise<void>
  /** Injected so "wait until reset" is computable without real time. */
  now?: () => number
  perPage?: number
  /** Conditional-request tags by URL, persisted between runs by the caller. */
  etags?: Map<string, string>
}

export class GithubError extends Error {}
export class GithubAuthError extends GithubError {}

const DEFAULT_BASE = 'https://api.github.com'

export class GithubIssueSource implements IssueSourcePort {
  private readonly fetch: FetchLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number
  private readonly baseUrl: string
  private readonly perPage: number
  readonly etags: Map<string, string>

  constructor(private readonly opts: GithubOptions) {
    this.fetch = opts.fetch ?? globalThis.fetch
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = opts.now ?? (() => Date.now())
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE
    this.perPage = opts.perPage ?? 100
    this.etags = opts.etags ?? new Map()
  }

  async *fetchUpdatedSince(cursor: Instant | null): AsyncIterable<ExternalIssue> {
    for (const repo of this.opts.repos) {
      yield* this.walk(repo, cursor)
    }
  }

  /**
   * Full scan. Its purpose is to observe what an incremental query structurally
   * cannot — an issue transferred away, deleted, or edited without its
   * `updated_at` moving — so passing the cursor here would defeat the point.
   */
  async *fetchAll(): AsyncIterable<ExternalIssue> {
    for (const repo of this.opts.repos) {
      yield* this.walk(repo, null)
    }
  }

  private async *walk(repo: GithubRepo, since: Instant | null): AsyncIterable<ExternalIssue> {
    let url: string | null = this.firstPage(repo, since)

    while (url) {
      const res = await this.request(url, repo)

      // 304: nothing changed. No items, and the caller's cursor is left alone.
      if (res.status === 304) return

      const etag = res.headers.get('ETag')
      if (etag) this.etags.set(url, etag)

      const body = (await res.json()) as unknown[]
      for (const raw of body) {
        const issue = toExternalIssue(raw, repo)
        if (issue) yield issue
      }

      url = nextLink(res.headers.get('Link'))
    }
  }

  private firstPage(repo: GithubRepo, since: Instant | null): string {
    const params = new URLSearchParams({
      // Closing an issue is exactly the kind of update the tool must observe,
      // and the endpoint defaults to open-only.
      state: 'all',
      per_page: String(this.perPage),
      sort: 'updated',
      direction: 'asc',
    })
    if (since) params.set('since', since)

    return `${this.baseUrl}/repos/${repo.owner}/${repo.repo}/issues?${params.toString()}`
  }

  /**
   * The only place an HTTP request is made, and the only place a method is
   * chosen. It is GET, unconditionally.
   */
  private async request(url: string, repo: GithubRepo, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (this.opts.token) headers['Authorization'] = `Bearer ${this.opts.token}`

    const etag = this.etags.get(url)
    if (etag) headers['If-None-Match'] = etag

    const res = await this.fetch(url, { method: 'GET', headers })

    if (res.status === 401) {
      throw new GithubAuthError(
        'GitHub rejected the credentials (HTTP 401). Check GITHUB_TOKEN.',
      )
    }

    if (res.status === 404) {
      throw new GithubError(
        `${repo.owner}/${repo.repo} not found (HTTP 404). ` +
          `Either it does not exist, or the token cannot see it.`,
      )
    }

    if (isRateLimited(res)) {
      if (retried) {
        throw new GithubError(
          `GitHub rate limit still exhausted for ${repo.owner}/${repo.repo}. Try again later.`,
        )
      }
      const resetAt = Number(res.headers.get('X-RateLimit-Reset') ?? '0') * 1000
      await this.sleep(Math.max(resetAt - this.now(), 0))
      return this.request(url, repo, true)
    }

    // 304 is a success — nothing changed since the stored ETag — but `res.ok`
    // covers 200–299 only, so it has to be admitted explicitly.
    if (!res.ok && res.status !== 304) {
      throw new GithubError(
        `GitHub request failed: HTTP ${res.status} for ${repo.owner}/${repo.repo}`,
      )
    }

    return res
  }
}

/** 403 with the remaining count at zero is a rate limit, not a permission error. */
function isRateLimited(res: Response): boolean {
  return (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('X-RateLimit-Remaining') === '0'
  )
}

/**
 * Maps one API item, or null when it should be skipped.
 *
 * The issues endpoint returns pull requests too. Without this filter every PR
 * would become a fake ticket.
 */
export function toExternalIssue(raw: unknown, repo: GithubRepo): ExternalIssue | null {
  const item = raw as {
    number?: number
    title?: string
    body?: string | null
    state?: string
    labels?: ({ name?: string } | string)[]
    user?: { login?: string }
    created_at?: string
    updated_at?: string
    pull_request?: unknown
  }

  if (item.pull_request !== undefined) return null
  if (typeof item.number !== 'number') return null

  return {
    owner: repo.owner,
    repo: repo.repo,
    number: item.number,
    title: item.title ?? '',
    body: item.body ?? '',
    state: item.state === 'closed' ? 'closed' : 'open',
    labels: (item.labels ?? []).map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    author: item.user?.login ?? '',
    createdAt: item.created_at ?? '',
    updatedAt: item.updated_at ?? '',
  }
}

/** Extracts `rel="next"` from a Link header. Absent means the last page. */
export function nextLink(header: string | null): string | null {
  if (!header) return null

  for (const part of header.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match) return match[1] ?? null
  }
  return null
}
