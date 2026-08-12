/**
 * TC-I-GH — docs/testcase/integration/TC-I-github-adapter.md
 *
 * Hand-written fixtures with placeholder identities. Never paste a real API
 * response here: this repository is public and the issues belong to someone else.
 */

import { describe, expect, it } from 'vitest'
import {
  GithubAuthError,
  GithubError,
  GithubIssueSource,
  nextLink,
  toExternalIssue,
} from '../../src/adapters/github.js'
import type { ExternalIssue } from '../../src/core/ticket.js'

const REPO = { owner: 'acme', repo: 'app' }
const BASE = 'https://api.example.test'

interface Reply {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

function stub(replies: Reply[]) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = []
  let i = 0

  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: (init.headers ?? {}) as Record<string, string>,
    })
    const reply = replies[Math.min(i++, replies.length - 1)] ?? {}
    const status = reply.status ?? 200

    // 304 is a null-body status; the Response constructor rejects a body with it.
    const body = status === 304 ? null : reply.body === undefined ? '[]' : JSON.stringify(reply.body)

    return new Response(body, { status, headers: reply.headers ?? {} })
  }

  return { calls, fetch }
}

function source(replies: Reply[], over: Partial<ConstructorParameters<typeof GithubIssueSource>[0]> = {}) {
  const s = stub(replies)
  const src = new GithubIssueSource({
    repos: [REPO],
    baseUrl: BASE,
    token: 'test-token',
    fetch: s.fetch,
    sleep: async () => {},
    now: () => 0,
    ...over,
  })
  return { source: src, calls: s.calls }
}

const ISSUE = {
  number: 42,
  title: 'Login fails after password reset',
  body: 'Steps to reproduce...',
  state: 'open',
  labels: [{ name: 'bug' }, { name: 'priority-high' }],
  user: { login: 'alice' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-11T00:00:00Z',
}

async function drain(it: AsyncIterable<ExternalIssue>): Promise<ExternalIssue[]> {
  const out: ExternalIssue[] = []
  for await (const v of it) out.push(v)
  return out
}

describe('TC-I-GH — read-only guarantee', () => {
  it('TC-I-GH-01 the adapter exposes no write capability', () => {
    const { source: src } = source([])

    // Not a matter of discipline: there is no method to call. If one is ever
    // added, this fails before anything reaches a customer repository.
    for (const name of ['create', 'update', 'comment', 'close', 'save', 'delete', 'patch']) {
      expect((src as unknown as Record<string, unknown>)[name]).toBeUndefined()
    }

    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(src))
      .filter((n) => n !== 'constructor' && !n.startsWith('#'))
      .sort()
    expect(surface).toEqual(['fetchAll', 'fetchUpdatedSince', 'firstPage', 'request', 'walk'])
  })

  it('TC-I-GH-02 only GET requests are issued', async () => {
    const { source: src, calls } = source([{ body: [ISSUE] }])

    await drain(src.fetchUpdatedSince(null))
    await drain(src.fetchAll())

    expect(calls).not.toHaveLength(0)
    expect(calls.every((c) => c.method === 'GET')).toBe(true)
  })
})

describe('TC-I-GH — mapping', () => {
  it('TC-I-GH-03 an issue maps to ExternalIssue', () => {
    expect(toExternalIssue(ISSUE, REPO)).toEqual({
      owner: 'acme',
      repo: 'app',
      number: 42,
      title: 'Login fails after password reset',
      body: 'Steps to reproduce...',
      state: 'open',
      labels: ['bug', 'priority-high'],
      author: 'alice',
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-11T00:00:00Z',
    })
  })

  it('TC-I-GH-04 pull requests are excluded', async () => {
    const pr = { ...ISSUE, number: 43, pull_request: { url: 'https://example.test/pull/43' } }
    const { source: src } = source([{ body: [ISSUE, pr] }])

    const issues = await drain(src.fetchUpdatedSince(null))

    expect(issues.map((i) => i.number)).toEqual([42])
  })

  it('TC-I-GH-05 the repository identity travels with the issue', async () => {
    const { source: src } = source([{ body: [ISSUE] }], {
      repos: [REPO, { owner: 'acme', repo: 'other' }],
    })

    const issues = await drain(src.fetchUpdatedSince(null))

    // The same issue number in two repositories must stay distinguishable.
    expect(issues.map((i) => `${i.owner}/${i.repo}#${i.number}`)).toEqual([
      'acme/app#42',
      'acme/other#42',
    ])
  })

  it('TC-I-GH-06 non-Latin titles and bodies are preserved verbatim', () => {
    const title = '【不具合】ログインできない'
    const body = '再現手順：\n\n1. パスワードを再設定する'

    const mapped = toExternalIssue({ ...ISSUE, title, body }, REPO)

    expect(mapped?.title).toBe(title)
    expect(mapped?.body).toBe(body)
  })

  it('TC-I-GH-06b a null body becomes an empty string, not "null"', () => {
    expect(toExternalIssue({ ...ISSUE, body: null }, REPO)?.body).toBe('')
  })
})

describe('TC-I-GH — incremental fetch', () => {
  it('TC-I-GH-07 since and state=all are both sent', async () => {
    const { source: src, calls } = source([{ body: [] }])

    await drain(src.fetchUpdatedSince('2026-08-10T00:00:00Z'))

    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get('since')).toBe('2026-08-10T00:00:00Z')
    // Closing an issue is an update the tool must observe; the endpoint
    // defaults to open-only.
    expect(url.searchParams.get('state')).toBe('all')
  })

  it('TC-I-GH-08 a stored ETag is sent as If-None-Match', async () => {
    const etags = new Map<string, string>()
    const { source: src, calls } = source([{ body: [ISSUE], headers: { ETag: 'W/"abc"' } }], { etags })

    await drain(src.fetchUpdatedSince(null))
    await drain(src.fetchUpdatedSince(null))

    expect(calls[0]?.headers['If-None-Match']).toBeUndefined()
    expect(calls[1]?.headers['If-None-Match']).toBe('W/"abc"')
  })

  it('TC-I-GH-09 a 304 yields no items', async () => {
    const { source: src } = source([{ status: 304 }])
    expect(await drain(src.fetchUpdatedSince('2026-08-10T00:00:00Z'))).toEqual([])
  })

  it('TC-I-GH-10 pagination follows the Link header until exhausted', async () => {
    const page2 = `${BASE}/repos/acme/app/issues?page=2`
    const { source: src, calls } = source([
      { body: [ISSUE], headers: { Link: `<${page2}>; rel="next", <${page2}>; rel="last"` } },
      { body: [{ ...ISSUE, number: 43 }] },
    ])

    const issues = await drain(src.fetchUpdatedSince(null))

    expect(issues.map((i) => i.number)).toEqual([42, 43])
    expect(calls[1]?.url).toBe(page2)
  })

  it('TC-I-GH-10b a Link header without rel="next" ends pagination', () => {
    expect(nextLink('<https://example.test/x?page=1>; rel="prev"')).toBeNull()
    expect(nextLink(null)).toBeNull()
  })

  it('TC-I-GH-11 fetchAll ignores the cursor', async () => {
    const { source: src, calls } = source([{ body: [] }])

    await drain(src.fetchAll())

    expect(new URL(calls[0]!.url).searchParams.get('since')).toBeNull()
  })
})

describe('TC-I-GH — rate limits', () => {
  it('TC-I-GH-12 a rate-limit response is retried after the reset time', async () => {
    let slept = -1
    const { source: src, calls } = source(
      [
        { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '60' } },
        { body: [ISSUE] },
      ],
      { sleep: async (ms: number) => void (slept = ms), now: () => 0 },
    )

    const issues = await drain(src.fetchUpdatedSince(null))

    expect(issues.map((i) => i.number)).toEqual([42])
    expect(calls).toHaveLength(2)
    expect(slept).toBe(60_000) // waits until reset, computed from the injected clock
  })

  it('TC-I-GH-12b a persistent rate limit surfaces a clear error', async () => {
    const { source: src } = source([
      { status: 403, headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': '60' } },
    ])

    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(/rate limit still exhausted/)
  })

  it('TC-I-GH-12c a 403 that is not a rate limit is not retried', async () => {
    const { source: src, calls } = source([
      { status: 403, headers: { 'X-RateLimit-Remaining': '4999' } },
    ])

    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(GithubError)
    expect(calls).toHaveLength(1)
  })
})

describe('TC-I-GH — errors', () => {
  it('TC-I-GH-13 404 reports the repository name and likely cause', async () => {
    const { source: src } = source([{ status: 404 }])

    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(/acme\/app/)
    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(/does not exist.*cannot see it/s)
  })

  it('TC-I-GH-14 401 reports which token variable to check', async () => {
    const { source: src } = source([{ status: 401 }])

    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(GithubAuthError)
    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(/GITHUB_TOKEN/)
  })

  it('TC-I-GH-14b the token itself never appears in an error', async () => {
    const { source: src } = source([{ status: 401 }])

    await expect(drain(src.fetchUpdatedSince(null))).rejects.toThrow(
      expect.not.stringContaining('test-token') as unknown as string,
    )
  })
})
