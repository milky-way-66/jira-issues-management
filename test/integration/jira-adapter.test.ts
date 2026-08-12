/**
 * TC-I-JIRA — docs/testcase/integration/TC-I-jira-adapter.md
 *
 * Fixtures are written by hand with placeholder values. Never paste a live API
 * response into this repository: it is public, and real responses carry
 * customer content.
 */

import { describe, expect, it } from 'vitest'
import {
  JiraAuthError,
  JiraError,
  JiraTracker,
  assertSafeHost,
  buildJql,
} from '../../src/adapters/jira.js'
import { markdownToWiki, wikiToMarkdown } from '../../src/adapters/jira-wiki.js'
import type { FieldChange } from '../../src/core/ticket.js'

const BASE = 'http://127.0.0.1:9999'

interface Call {
  url: string
  method: string
  body: unknown
}

/** Records requests and replies from a queue, so no server is needed. */
function stub(responses: (unknown | { status: number; body?: unknown; headers?: Record<string, string> })[]) {
  const calls: Call[] = []
  let i = 0

  const fetch = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    })

    const next = responses[Math.min(i++, responses.length - 1)]
    const spec =
      next && typeof next === 'object' && 'status' in next
        ? (next as { status: number; body?: unknown; headers?: Record<string, string> })
        : { status: 200, body: next }

    return new Response(spec.body === undefined ? '' : JSON.stringify(spec.body), {
      status: spec.status,
      headers: spec.headers ?? {},
    })
  }

  return { calls, fetch }
}

function tracker(
  responses: unknown[],
  over: Partial<ConstructorParameters<typeof JiraTracker>[0]> = {},
) {
  const s = stub(responses)
  const t = new JiraTracker({
    baseUrl: BASE,
    project: 'PROJ',
    token: 'test-token',
    epicLinkField: 'customfield_10014',
    fetch: s.fetch,
    sleep: async () => {},
    ...over,
  })
  return { tracker: t, calls: s.calls }
}

const ISSUE = {
  key: 'PROJ-123',
  fields: {
    summary: 'Review monitoring documentation',
    description: 'h2. Description\n\nSome *bold* text.',
    status: { name: 'In Progress' },
    assignee: { name: 'alice' },
    issuetype: { name: 'Task' },
    labels: ['docs-qa', 'monitoring'],
    priority: { name: 'Medium' },
    duedate: '2026-08-20',
    timetracking: { originalEstimate: '4h' },
    updated: '2026-08-11T09:00:00.000+0900',
    customfield_10014: 'PROJ-100',
  },
}

describe('TC-I-JIRA — mapping', () => {
  it('TC-I-JIRA-01 a REST v2 issue maps onto RemoteTicket', () => {
    const { tracker: t } = tracker([])
    const r = t.toRemoteTicket(ISSUE)

    expect(r.key).toBe('PROJ-123')
    expect(r.fields.title).toBe('Review monitoring documentation')
    expect(r.fields.status).toBe('In Progress')
    expect(r.fields.assignee).toBe('alice')
    expect(r.fields.type).toBe('Task')
    expect(r.fields.labels).toEqual(['docs-qa', 'monitoring'])
    expect(r.fields.priority).toBe('Medium')
    expect(r.fields.due).toBe('2026-08-20')
    expect(r.fields.estimate).toBe('4h')
    expect(r.fields.body).toContain('## Description')
  })

  it('TC-I-JIRA-02 the Epic Link custom field maps to parent', () => {
    const { tracker: t } = tracker([])
    const r = t.toRemoteTicket(ISSUE)

    expect(r.fields.parent).toBe('PROJ-100')
    expect(JSON.stringify(r)).not.toMatch(/customfield_/)
  })

  it('TC-I-JIRA-03 an unset assignee becomes null, not the string "null"', () => {
    const { tracker: t } = tracker([])
    const r = t.toRemoteTicket({ ...ISSUE, fields: { ...ISSUE.fields, assignee: null } })

    expect(r.fields.assignee).toBeNull()
  })

  it('TC-I-JIRA-04 missing optional fields become absent, not empty string', () => {
    const { tracker: t } = tracker([])
    const r = t.toRemoteTicket({ key: 'PROJ-1', fields: { summary: 'T' } })

    expect(r.fields.due).toBeNull()
    expect(r.fields.priority).toBeNull()
    expect(r.fields.estimate).toBeNull()
    expect(r.fields.parent).toBeNull()
  })

  it('TC-I-JIRA-05 unknown fields are ignored without error', () => {
    const { tracker: t } = tracker([])
    const r = t.toRemoteTicket({
      ...ISSUE,
      fields: { ...ISSUE.fields, customfield_99999: 'whatever', somethingNew: { a: 1 } },
    })

    expect(r.key).toBe('PROJ-123')
  })

  it('TC-I-JIRA-05b an issue without a key is rejected', () => {
    const { tracker: t } = tracker([])
    expect(() => t.toRemoteTicket({ fields: {} })).toThrow(JiraError)
  })
})

describe('TC-I-JIRA — writes', () => {
  it('TC-I-JIRA-06 a status change goes through the transitions endpoint', async () => {
    const { tracker: t, calls } = tracker([
      { transitions: [{ id: '31', name: 'Start Review', to: { name: 'In Review' } }] },
      {},
    ])

    const change: FieldChange = {
      field: 'status',
      from: 'To Do',
      to: 'In Review',
      viaTransition: true,
    }
    await t.applyChanges('PROJ-123', [change])

    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
    const post = calls.find((c) => c.method === 'POST')
    expect(post?.url).toContain('/transitions')
    expect(post?.body).toEqual({ transition: { id: '31' } })
  })

  it('TC-I-JIRA-07 an unavailable transition fails loudly and writes nothing', async () => {
    const { tracker: t, calls } = tracker([
      { transitions: [{ id: '21', name: 'Done', to: { name: 'Done' } }] },
    ])

    await expect(
      t.applyChanges('PROJ-123', [
        { field: 'status', from: 'To Do', to: 'In Review', viaTransition: true },
      ]),
    ).rejects.toThrow(/no transition to "In Review".*Done/s)

    expect(calls.filter((c) => c.method === 'POST')).toEqual([])
  })

  it('TC-I-JIRA-08 labels are sent as add/remove operations', async () => {
    const { tracker: t, calls } = tracker([{}])

    await t.applyChanges('PROJ-123', [{ field: 'labels', add: ['c'], remove: ['b'] }])

    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ update: { labels: [{ add: 'c' }, { remove: 'b' }] } })
    expect(JSON.stringify(put?.body)).not.toContain('"fields"')
  })

  it('TC-I-JIRA-09 assignee is sent as name, never accountId', async () => {
    const { tracker: t, calls } = tracker([{}])

    await t.applyChanges('PROJ-123', [{ field: 'assignee', from: 'alice', to: 'bob' }])

    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toEqual({ fields: { assignee: { name: 'bob' } } })
    expect(JSON.stringify(put?.body)).not.toContain('accountId')
  })

  it('TC-I-JIRA-09b clearing the assignee sends null', async () => {
    const { tracker: t, calls } = tracker([{}])
    await t.applyChanges('PROJ-123', [{ field: 'assignee', from: 'alice', to: null }])
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ fields: { assignee: null } })
  })

  it('TC-I-JIRA-09c issue type is refused, never sent', async () => {
    const { tracker: t } = tracker([{}])
    await expect(
      t.applyChanges('PROJ-123', [{ field: 'type', from: 'Task', to: 'Sub-task' }]),
    ).rejects.toThrow(/never changed automatically/)
  })

  it('TC-I-JIRA-09d creation carries the description as wiki markup', async () => {
    const { tracker: t, calls } = tracker([{ key: 'PROJ-500' }])

    const key = await t.create({
      localId: 'LOCAL-0007',
      fields: {
        title: 'New',
        body: '## Heading\n\n**bold**',
        status: 'To Do',
        assignee: null,
        type: 'Task',
        parent: 'PROJ-100',
        labels: ['sync-LOCAL-0007'],
        priority: null,
        estimate: null,
        due: null,
      },
    })

    expect(key).toBe('PROJ-500')
    const body = calls[0]?.body as { fields: Record<string, unknown> }
    expect(body.fields['description']).toContain('h2. Heading')
    expect(body.fields['labels']).toEqual(['sync-LOCAL-0007'])
    expect(body.fields['customfield_10014']).toBe('PROJ-100')
  })
})

describe('TC-I-JIRA — wiki markup', () => {
  it('TC-I-JIRA-10 Markdown converts to wiki markup', () => {
    expect(markdownToWiki('## Heading')).toBe('h2. Heading')
    expect(markdownToWiki('**bold**')).toBe('*bold*')
    expect(markdownToWiki('*italic*')).toBe('_italic_')
    expect(markdownToWiki('`code`')).toBe('{{code}}')
    expect(markdownToWiki('- item')).toBe('* item')
    expect(markdownToWiki('1. item')).toBe('# item')
    expect(markdownToWiki('[label](https://example.com)')).toBe('[label|https://example.com]')
    expect(markdownToWiki('```ts\nconst a = 1\n```')).toBe('{code:ts}\nconst a = 1\n{code}')
  })

  it('TC-I-JIRA-11 wiki markup converts back to Markdown', () => {
    expect(wikiToMarkdown('h2. Heading')).toBe('## Heading')
    expect(wikiToMarkdown('*bold*')).toBe('**bold**')
    expect(wikiToMarkdown('_italic_')).toBe('*italic*')
    expect(wikiToMarkdown('{{code}}')).toBe('`code`')
    expect(wikiToMarkdown('* item')).toBe('- item')
    expect(wikiToMarkdown('# item')).toBe('1. item')
    // Wiki ordered items carry no number; the position has to be reconstructed.
    expect(wikiToMarkdown('# one\n# two\n# three')).toBe('1. one\n2. two\n3. three')
    // And a paragraph ends the list, so the next one starts at 1 again.
    expect(wikiToMarkdown('# one\n# two\n\ntext\n\n# a')).toBe('1. one\n2. two\n\ntext\n\n1. a')
    expect(wikiToMarkdown('[label|https://example.com]')).toBe('[label](https://example.com)')
    expect(wikiToMarkdown('{code:ts}\nconst a = 1\n{code}')).toBe('```ts\nconst a = 1\n```')
  })

  const BODIES = [
    'h2. Description\n\nPlain paragraph.',
    'h1. A\n\nh3. B\n\ntext',
    '* one\n* two\n* three',
    '# first\n# second',
    'Some *bold* and _italic_ together.',
    'Inline {{code}} in a sentence.',
    '{code:ts}\nconst a = 1\n{code}',
    '{code}\nplain block\n{code}',
    'A [link|https://example.com] inline.',
    'h2. 【監視】通知設定\n\n本文テキスト。全角記号：あり。',
    'Mixed 日本語 and *bold* text.',
    '',
    'Trailing spaces   \nand a second line.',
    'Symbols that look like markup: 2 * 3 * 4 = 24',
    '{code}\nh2. not a heading inside code\n* not a list\n{code}',
  ]

  it.each(BODIES)('TC-I-JIRA-12 round trip is stable: %j', (wiki) => {
    const once = markdownToWiki(wikiToMarkdown(wiki))
    const twice = markdownToWiki(wikiToMarkdown(once))

    // Stability is the requirement: the second pass must change nothing, or the
    // tool rewrites the ticket on every sync forever.
    expect(twice).toBe(once)
  })

  it.each(BODIES)('TC-I-JIRA-12b md round trip is stable: %j', (wiki) => {
    const md = wikiToMarkdown(wiki)
    expect(wikiToMarkdown(markdownToWiki(md))).toBe(md)
  })

  /**
   * The fixtures above all start from wiki, which cannot express a wrong
   * number — every item is `#`. Local ticket bodies are Markdown, and Markdown
   * can, so this direction is where renumbering bugs actually live. A real one
   * hid here: `2. Sign in` came back as `1. Sign in`, which made every sync of
   * any ticket with a numbered list raise a body conflict against itself.
   */
  const MD_BODIES = [
    '1. first\n2. second\n3. third',
    'Steps:\n\n1. Open the app\n2. Sign in\n\nDone.',
    '1. one\n2. two\n\ntext\n\n1. a\n2. b',
    '## Heading\n\n1. after a heading\n2. still counting',
    '- a\n- b\n\n1. one\n2. two',
    '1. list\n\n```ts\nconst a = 1\n```\n\n1. after code',
  ]

  it.each(MD_BODIES)('TC-I-JIRA-12c a Markdown body survives the round trip: %j', (md) => {
    expect(wikiToMarkdown(markdownToWiki(md))).toBe(md)
  })

  it('TC-I-JIRA-13 non-Latin text survives conversion unchanged', () => {
    const text = '【監視】通知設定の見直し — 全角：カタカナ、漢字。'
    expect(wikiToMarkdown(markdownToWiki(text))).toBe(text)
  })

  it('TC-I-JIRA-14 an unconvertible construct degrades instead of throwing', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |'
    expect(() => markdownToWiki(md)).not.toThrow()
    expect(markdownToWiki(md)).toContain('a')
  })
})

describe('TC-I-JIRA — queries', () => {
  it('TC-I-JIRA-15 the JQL names the project, bounds updated, and orders ascending', () => {
    const jql = buildJql('PROJ', '2026-08-11T09:00:00+09:00')

    expect(jql).toContain('project = "PROJ"')
    expect(jql).toContain('updated >=')
    expect(jql).toMatch(/ORDER BY updated ASC$/)
  })

  it('TC-I-JIRA-15b the bound is rewound to absorb clock skew', () => {
    // 09:00 minus the five-minute overlap.
    expect(buildJql('PROJ', '2026-08-11T09:00:00+09:00')).toContain('2026/08/11 08:55')
  })

  it('TC-I-JIRA-15c a first run has no updated bound', () => {
    expect(buildJql('PROJ', null)).toBe('project = "PROJ" ORDER BY updated ASC')
  })

  it('TC-I-JIRA-16 paging follows startAt until exhausted', async () => {
    const { tracker: t, calls } = tracker([
      { issues: [ISSUE, { ...ISSUE, key: 'PROJ-124' }], total: 3 },
      { issues: [{ ...ISSUE, key: 'PROJ-125' }], total: 3 },
    ])

    const keys: string[] = []
    for await (const r of t.fetchUpdatedSince(null)) keys.push(r.key)

    expect(keys).toEqual(['PROJ-123', 'PROJ-124', 'PROJ-125'])
    expect(calls[0]?.url).toContain('startAt=0')
    expect(calls[1]?.url).toContain('startAt=2')
  })

  it('TC-I-JIRA-17 the sync-label lookup returns at most one key', async () => {
    const { tracker: t, calls } = tracker([{ issues: [{ key: 'PROJ-500' }] }])

    expect(await t.findBySyncLabel('LOCAL-0007')).toBe('PROJ-500')
    expect(decodeURIComponent(calls[0]?.url ?? '')).toContain('labels = "sync-LOCAL-0007"')
  })

  it('TC-I-JIRA-17b no match returns null', async () => {
    const { tracker: t } = tracker([{ issues: [] }])
    expect(await t.findBySyncLabel('LOCAL-0008')).toBeNull()
  })
})

describe('TC-I-JIRA — errors', () => {
  it('TC-I-JIRA-18 401 names the token variable to check', async () => {
    const { tracker: t } = tracker([{ status: 401 }])

    await expect(t.fetchOne('PROJ-1')).rejects.toThrow(JiraAuthError)
    await expect(t.fetchOne('PROJ-1')).rejects.toThrow(/JIRA_PAT/)
  })

  it('TC-I-JIRA-18b the token itself never appears in an error', async () => {
    const { tracker: t } = tracker([{ status: 403 }])

    await expect(t.fetchOne('PROJ-1')).rejects.toThrow(
      expect.not.stringContaining('test-token') as unknown as string,
    )
  })

  it('TC-I-JIRA-19 429 is retried after the advertised delay', async () => {
    const { tracker: t, calls } = tracker([
      { status: 429, headers: { 'Retry-After': '1' } },
      { key: 'PROJ-1', fields: { summary: 'ok' } },
    ])

    const result = await t.fetchOne('PROJ-1')
    expect(result?.key).toBe('PROJ-1')
    expect(calls).toHaveLength(2)
  })

  it('TC-I-JIRA-19b persistent 429 eventually surfaces', async () => {
    const { tracker: t } = tracker([{ status: 429, headers: { 'Retry-After': '1' } }])
    await expect(t.fetchOne('PROJ-1')).rejects.toThrow(/HTTP 429/)
  })

  it('TC-I-JIRA-20 a malformed body reports the path, not a bare parse error', async () => {
    const s = {
      fetch: async () => new Response('<html>not json</html>', { status: 200 }),
    }
    const t = new JiraTracker({
      baseUrl: BASE,
      project: 'PROJ',
      token: 'x',
      epicLinkField: null,
      fetch: s.fetch as never,
    })

    await expect(t.fetchOne('PROJ-1')).rejects.toThrow(/malformed response.*PROJ-1/s)
  })

  it('TC-I-JIRA-20b a missing issue returns null rather than throwing', async () => {
    const { tracker: t } = tracker([{ status: 404 }])
    expect(await t.fetchOne('PROJ-404')).toBeNull()
  })
})

describe('TC-I-JIRA — safety', () => {
  it('TC-E-SAFE-01 refuses a non-loopback host while tests are running', () => {
    expect(() => assertSafeHost('https://jira.example.com')).toThrow(/only loopback/)
    expect(() => assertSafeHost('http://127.0.0.1:9999')).not.toThrow()
    expect(() => assertSafeHost('http://localhost:9999')).not.toThrow()
  })

  it('TC-E-SAFE-01b the constructor enforces it too', () => {
    expect(
      () =>
        new JiraTracker({
          baseUrl: 'https://jira.example.com',
          project: 'PROJ',
          token: 'x',
          epicLinkField: null,
        }),
    ).toThrow(/only loopback/)
  })
})
