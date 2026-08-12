/**
 * Opt-in checks against a real Jira instance.
 *
 * Skipped unless `MGMT_LIVE_JIRA_URL` and `MGMT_LIVE_JIRA_PAT` are set, so
 * `npm test` on a laptop or in CI never reaches a tracker. Point it at the
 * Docker instance from docs/local-jira.md:
 *
 *   MGMT_LIVE_JIRA_URL=http://localhost:8080 \
 *   MGMT_LIVE_JIRA_PAT=... \
 *   MGMT_LIVE_JIRA_PROJECT=PROJ \
 *   npm run test:live
 *
 * These answer the one question the in-process substitute cannot: does the
 * field mapping match what a real instance actually returns? A fixture invented
 * from a specification encodes the guess, not the fact — so everything here
 * reads from the live server and asserts against its *shape*, never against a
 * value this repository chose.
 *
 * The loopback guard still applies. A non-loopback URL is refused, which is why
 * this works against a container and not against production.
 */

import { describe, expect, it } from 'vitest'
import { JiraTracker } from '../../src/adapters/jira.js'
import { markdownToWiki, wikiToMarkdown } from '../../src/adapters/jira-wiki.js'
import type { RemoteTicket } from '../../src/core/ticket.js'

const url = process.env['MGMT_LIVE_JIRA_URL']
const token = process.env['MGMT_LIVE_JIRA_PAT']
const project = process.env['MGMT_LIVE_JIRA_PROJECT'] ?? 'PROJ'

const live = url && token ? describe : describe.skip

function tracker(epicLinkField: string | null = null): JiraTracker {
  return new JiraTracker({
    baseUrl: url!,
    project,
    token: token!,
    epicLinkField,
  })
}

async function firstIssue(): Promise<RemoteTicket | null> {
  for await (const issue of tracker().fetchUpdatedSince(null)) return issue
  return null
}

live('live Jira — the instance is what we think it is', () => {
  it('is Server or Data Center, not Cloud', async () => {
    const info = await tracker().serverInfo()

    // Cloud is a different API version with different body and user shapes.
    // Discovering that late produces confusing failures far from the cause.
    expect(info.deploymentType.toLowerCase()).not.toBe('cloud')
    expect(info.version).toMatch(/^\d+\./)
  })

  it('reports its Epic Link field id, or clearly has none', async () => {
    const field = await tracker().discoverEpicLinkField()

    // Either answer is fine; a wrong *guess* is not. Writing a parent into
    // whatever field happens to hold that number is silent and hard to undo.
    if (field !== null) expect(field).toMatch(/^customfield_\d+$/)
  })
})

live('live Jira — field mapping matches reality', () => {
  it('maps a real issue onto RemoteTicket without losing required fields', async () => {
    const issue = await firstIssue()
    if (!issue) return expect.fail(`no issues in project ${project}; create one first`)

    // Required by the local file format — a null here means the mapping is wrong,
    // not that the issue is unusual.
    expect(issue.key).toMatch(/^[A-Z][A-Z0-9]*-\d+$/)
    expect(typeof issue.fields.title).toBe('string')
    expect(issue.fields.title.length).toBeGreaterThan(0)
    expect(issue.fields.status.length).toBeGreaterThan(0)
    expect(issue.fields.type.length).toBeGreaterThan(0)
    expect(issue.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('leaves no provider-specific key in the mapped result', async () => {
    const issue = await firstIssue()
    if (!issue) return

    // The core must never see a customfield id or an accountId. If one leaks
    // through, the hexagon boundary has stopped holding.
    const serialised = JSON.stringify(issue)
    expect(serialised).not.toMatch(/customfield_/)
    expect(serialised).not.toMatch(/accountId/)
  })

  it('never produces the string "null" for an absent value', async () => {
    for await (const issue of tracker().fetchUpdatedSince(null)) {
      for (const [name, value] of Object.entries(issue.fields)) {
        expect(`${name}=${String(value)}`).not.toMatch(/=(null|undefined)$/)
      }
    }
  })
})

live('live Jira — the body round trip is stable', () => {
  it('re-converting a real description changes nothing', async () => {
    let checked = 0

    for await (const issue of tracker().fetchUpdatedSince(null)) {
      const once = issue.fields.body
      const twice = wikiToMarkdown(markdownToWiki(once))

      // This is the failure that matters most in practice: if the round trip is
      // not a fixed point, every sync sees a body difference that is not there,
      // rewrites the ticket forever, and buries real changes in the noise.
      // Real descriptions contain constructs no invented fixture thought of.
      expect(twice, `unstable round trip for ${issue.key}`).toBe(once)
      checked++
    }

    expect(checked, `no issues in project ${project}; create a few with varied formatting`)
      .toBeGreaterThan(0)
  })
})

live('live Jira — reads never write', () => {
  it('a full read pass leaves every issue untouched', async () => {
    const before = new Map<string, string>()
    for await (const issue of tracker().fetchUpdatedSince(null)) {
      before.set(issue.key, issue.updated)
    }

    await tracker().findBySyncLabel('LOCAL-0001')
    for (const key of before.keys()) await tracker().fetchOne(key)

    for await (const issue of tracker().fetchUpdatedSince(null)) {
      // `updated` moves on any write. Unchanged timestamps across a read pass
      // is the strongest available evidence that nothing was written.
      expect(issue.updated, `${issue.key} changed during a read-only pass`).toBe(
        before.get(issue.key),
      )
    }
  })
})
