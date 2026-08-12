/**
 * TC-I-FAKE — docs/testcase/integration/TC-I-fake-jira.md
 *
 * These run the real adapter against the substitute over a real loopback
 * socket, using the platform `fetch`. No fixture is injected, so URL building,
 * headers, status codes and paging are all genuinely exercised.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JiraAuthError, JiraTracker } from '../../src/adapters/jira.js'
import { FakeJira } from '../support/fake-jira.js'

let jira: FakeJira
let baseUrl: string

function tracker(over: Partial<ConstructorParameters<typeof JiraTracker>[0]> = {}) {
  return new JiraTracker({
    baseUrl,
    project: jira.project,
    token: jira.token,
    epicLinkField: jira.epicLinkField,
    pageSize: 2,
    sleep: async () => {},
    ...over,
  })
}

beforeEach(async () => {
  jira = new FakeJira()
  baseUrl = await jira.start()
})

afterEach(async () => {
  await jira.stop()
})

describe('TC-I-FAKE — protocol fidelity', () => {
  it('TC-I-FAKE-01 the adapter reaches the substitute over a real socket', async () => {
    const key = jira.seed({ summary: 'Review monitoring documentation', assignee: 'alice' })

    const remote = await tracker().fetchOne(key)

    expect(remote?.key).toBe(key)
    expect(remote?.fields.title).toBe('Review monitoring documentation')
    expect(remote?.fields.assignee).toBe('alice')
    expect(remote?.updated).not.toBe('')
  })

  it('TC-I-FAKE-02 a wrong token is rejected with 401', async () => {
    jira.seed({ summary: 'T' }, 'PROJ-1')

    const wrong = tracker({ token: 'not-the-token' })
    await expect(wrong.fetchOne('PROJ-1')).rejects.toThrow(JiraAuthError)
    await expect(wrong.fetchOne('PROJ-1')).rejects.toThrow(/JIRA_PAT/)
  })

  it('TC-I-FAKE-03 an absent issue answers 404 and the adapter returns null', async () => {
    expect(await tracker().fetchOne('PROJ-404')).toBeNull()
  })

  it('TC-I-FAKE-04 updated advances on every write', async () => {
    const key = jira.seed({ summary: 'T' })
    const first = String(jira.get(key)?.fields['updated'])

    jira.edit(key, { summary: 'T2' })
    const second = String(jira.get(key)?.fields['updated'])

    expect(Date.parse(second)).toBeGreaterThan(Date.parse(first))
  })
})

describe('TC-I-FAKE — search', () => {
  it('TC-I-FAKE-05 search pages through startAt until exhausted', async () => {
    const keys = [1, 2, 3, 4, 5].map((n) => jira.seed({ summary: `Issue ${n}` }))

    const seen: string[] = []
    for await (const r of tracker().fetchUpdatedSince(null)) seen.push(r.key)

    expect(seen).toEqual(keys)
    expect(new Set(seen).size).toBe(5)
  })

  it('TC-I-FAKE-06 the updated bound filters the result set', async () => {
    jira.seed({ summary: 'old' })

    // An hour of quiet, then a new issue. The cursor sits inside the gap, far
    // enough from both that the adapter's five-minute skew rewind cannot reach
    // across it — otherwise this would pass or fail for the wrong reason.
    jira.advance(60)
    const cursorMoment = jira.now()
    jira.advance(60)
    const recent = jira.seed({ summary: 'new' })

    const seen: string[] = []
    const later = cursorMoment
    for await (const r of tracker().fetchUpdatedSince(later)) seen.push(r.key)

    expect(seen).toEqual([recent])
  })

  it('TC-I-FAKE-07 the sync-label lookup finds an issue by label', async () => {
    const key = jira.seed({ summary: 'Created locally', labels: ['sync-LOCAL-0007'] })

    expect(await tracker().findBySyncLabel('LOCAL-0007')).toBe(key)
    expect(await tracker().findBySyncLabel('LOCAL-0008')).toBeNull()
  })
})

describe('TC-I-FAKE — writes', () => {
  it('TC-I-FAKE-08 status moves only through a declared transition', async () => {
    const key = jira.seed({ summary: 'T', status: 'To Do' })

    await expect(
      tracker().applyChanges(key, [
        { field: 'status', from: 'To Do', to: 'Pending Client Review', viaTransition: true },
      ]),
    ).rejects.toThrow(/no transition to "Pending Client Review"/)

    expect((jira.get(key)?.fields['status'] as { name: string }).name).toBe('To Do')
  })

  it('TC-I-FAKE-08b a permitted transition moves the status', async () => {
    const key = jira.seed({ summary: 'T', status: 'To Do' })

    await tracker().applyChanges(key, [
      { field: 'status', from: 'To Do', to: 'In Progress', viaTransition: true },
    ])

    expect((jira.get(key)?.fields['status'] as { name: string }).name).toBe('In Progress')
  })

  it('TC-I-FAKE-09 a direct write to the status field is refused', async () => {
    const key = jira.seed({ summary: 'T' })

    const res = await fetch(`${baseUrl}/rest/api/2/issue/${key}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${jira.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { status: { name: 'Done' } } }),
    })

    expect(res.status).toBe(400)
  })

  it('TC-I-FAKE-10 label operations leave untouched labels alone', async () => {
    const key = jira.seed({ summary: 'T', labels: ['docs-qa', 'set-by-someone-else'] })

    await tracker().applyChanges(key, [{ field: 'labels', add: ['monitoring'], remove: ['docs-qa'] }])

    expect(jira.get(key)?.fields['labels']).toEqual(['monitoring', 'set-by-someone-else'])
  })

  it('TC-I-FAKE-11 a created issue is retrievable by its returned key', async () => {
    const t = tracker()
    const key = await t.create({
      localId: 'LOCAL-0007',
      fields: {
        title: 'Locally drafted',
        body: '## Detail\n\ntext',
        status: 'To Do',
        assignee: null,
        type: 'Task',
        parent: null,
        labels: ['sync-LOCAL-0007'],
        priority: null,
        estimate: null,
        due: null,
      },
    })

    const remote = await t.fetchOne(key)
    expect(remote?.fields.title).toBe('Locally drafted')
    expect(remote?.fields.labels).toContain('sync-LOCAL-0007')
    expect(remote?.fields.body).toContain('## Detail')
  })
})

describe('TC-I-FAKE — safety', () => {
  it('TC-I-FAKE-12 a pull run issues no write request', async () => {
    jira.seed({ summary: 'one' })
    jira.seed({ summary: 'two' })
    jira.requests.length = 0

    for await (const _ of tracker().fetchUpdatedSince(null)) {
      /* drain */
    }
    await tracker().fetchOne(`${jira.project}-1`)
    await tracker().findBySyncLabel('LOCAL-0001')

    expect(jira.wroteNothing()).toBe(true)
  })
})
