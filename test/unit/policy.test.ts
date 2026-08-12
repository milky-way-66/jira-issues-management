/**
 * TC-U-POLICY — docs/testcase/unit/TC-U-policy.md
 */

import { describe, expect, it } from 'vitest'
import {
  autoPushRefusal,
  defaultOwner,
  draftFromExternalIssue,
  externalIssueFilename,
  formatLocalId,
  isAutoPushable,
  isLocalId,
  nextLocalId,
  normaliseLabels,
  normaliseScalar,
  requiresTransition,
  resolveOwner,
  syncLabel,
} from '../../src/core/policy.js'
import { merge3 } from '../../src/core/merge3.js'
import type { ExternalIssue, FieldSet } from '../../src/core/ticket.js'

function fields(over: Partial<FieldSet> = {}): FieldSet {
  return {
    title: 'T',
    body: '',
    status: 'To Do',
    assignee: null,
    type: 'Task',
    parent: null,
    labels: [],
    priority: null,
    estimate: null,
    due: null,
    ...over,
  }
}

describe('TC-U-POLICY — default owner on conflict', () => {
  it.each([
    ['TC-U-POLICY-01', 'status', 'jira'],
    ['TC-U-POLICY-02', 'assignee', 'jira'],
    ['TC-U-POLICY-03', 'type', 'jira'],
    ['TC-U-POLICY-04', 'parent', 'jira'],
    ['TC-U-POLICY-05', 'title', 'none'],
    ['TC-U-POLICY-06', 'body', 'none'],
    ['TC-U-POLICY-07', 'labels', 'none'],
  ] as const)('%s %s → %s', (_id, field, owner) => {
    expect(defaultOwner(field)).toBe(owner)
  })

  it('TC-U-POLICY-08 an explicit --take overrides the default', () => {
    // status defaults to the tracker, but the user may always decide otherwise.
    expect(defaultOwner('status')).toBe('jira')
    expect(resolveOwner('status', 'local')).toBe('local')
    expect(resolveOwner('status', 'jira')).toBe('jira')
  })

  it('TC-U-POLICY-08b with no explicit choice the default applies', () => {
    expect(resolveOwner('status')).toBe('jira')
    expect(resolveOwner('title')).toBe('none')
  })
})

describe('TC-U-POLICY — transitions', () => {
  it('TC-U-POLICY-09 a status push is marked as requiring a transition', () => {
    expect(requiresTransition('status')).toBe(true)

    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ status: 'To Do' }),
      local: fields({ status: 'In Review' }),
      remote: fields({ status: 'To Do' }),
    })

    expect(plan.push).toEqual([
      { field: 'status', from: 'To Do', to: 'In Review', viaTransition: true },
    ])
  })

  it('TC-U-POLICY-09b carries the status name, never a numeric id', () => {
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ status: 'To Do' }),
      local: fields({ status: 'In Review' }),
      remote: fields({ status: 'To Do' }),
    })
    const change = plan.push[0]
    if (!change || change.field !== 'status') throw new Error('expected a status push')
    expect(change.to).toBe('In Review')
    expect(Number.isNaN(Number(change.to))).toBe(true)
  })

  it('TC-U-POLICY-09c ordinary fields need no transition', () => {
    expect(requiresTransition('title')).toBe(false)
  })
})

describe('TC-U-POLICY — issue type', () => {
  it('TC-U-POLICY-10 a local type change warns instead of pushing', () => {
    expect(isAutoPushable('type')).toBe(false)

    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ type: 'Task' }),
      local: fields({ type: 'Sub-task' }),
      remote: fields({ type: 'Task' }),
    })

    expect(plan.push).toEqual([])
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).toContain('type')
  })

  it('TC-U-POLICY-10c the refusal message renders absent values readably', () => {
    expect(autoPushRefusal('type', null, 'Task')).toContain('∅ → Task')
    expect(autoPushRefusal('type', 'Task', null)).toContain('Task → ∅')
  })

  it('TC-U-POLICY-10b a remote type change still pulls', () => {
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ type: 'Task' }),
      local: fields({ type: 'Task' }),
      remote: fields({ type: 'Sub-task' }),
    })
    expect(plan.pull).toEqual([{ field: 'type', from: 'Task', to: 'Sub-task' }])
  })
})

describe('TC-U-POLICY — vocabulary isolation', () => {
  it('TC-U-POLICY-11 no provider-specific identifiers appear in a plan', () => {
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ parent: 'PROJ-100', assignee: 'alice', labels: ['a'] }),
      local: fields({ parent: 'PROJ-200', assignee: 'bob', labels: ['a', 'b'] }),
      remote: fields({ parent: 'PROJ-300', assignee: 'carol', labels: [] }),
    })

    const json = JSON.stringify(plan)
    expect(json).not.toMatch(/customfield_/)
    expect(json).not.toMatch(/accountId/)
  })

  it('TC-U-POLICY-12 hierarchy is expressed as `parent`', () => {
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ parent: null }),
      local: fields({ parent: 'PROJ-100' }),
      remote: fields({ parent: null }),
    })
    expect(plan.push).toEqual([{ field: 'parent', from: null, to: 'PROJ-100' }])
  })
})

describe('TC-U-POLICY — promotion', () => {
  const issue: ExternalIssue = {
    owner: 'acme',
    repo: 'app',
    number: 412,
    title: '【監視】通知設定の見直し',
    body: 'Reported by a customer.',
    state: 'open',
    labels: ['bug'],
    author: 'bob',
    createdAt: '2026-08-10T14:00:00+09:00',
    updatedAt: '2026-08-10T14:22:00+09:00',
  }

  it('TC-U-POLICY-13 produces a draft with a local id and source link', () => {
    const draft = draftFromExternalIssue(issue, 'LOCAL-0008')
    expect(draft.localId).toBe('LOCAL-0008')
    expect(isLocalId(draft.localId)).toBe(true)
    expect(draft.source).toEqual({ owner: 'acme', repo: 'app', number: 412 })
  })

  it('TC-U-POLICY-14 attaches the duplicate-protection label', () => {
    const draft = draftFromExternalIssue(issue, 'LOCAL-0008')
    expect(draft.fields.labels).toContain('sync-LOCAL-0008')
    expect(syncLabel('LOCAL-0008')).toBe('sync-LOCAL-0008')
  })

  it('TC-U-POLICY-15 preserves the title verbatim, including non-Latin text', () => {
    const draft = draftFromExternalIssue(issue, 'LOCAL-0008')
    expect(draft.fields.title).toBe(issue.title)
  })

  it('TC-U-POLICY-15b honours explicit promotion options', () => {
    const draft = draftFromExternalIssue(issue, 'LOCAL-0009', {
      type: 'Sub-task',
      parent: 'PROJ-100',
      labels: ['triaged'],
    })
    expect(draft.fields.type).toBe('Sub-task')
    expect(draft.fields.parent).toBe('PROJ-100')
    expect(draft.fields.labels).toEqual(['sync-LOCAL-0009', 'triaged'])
  })

  it('TC-U-POLICY-16 allocates local ids sequentially', () => {
    expect(nextLocalId(7)).toBe('LOCAL-0008')
    expect(nextLocalId(8)).toBe('LOCAL-0009')
    expect(formatLocalId(1)).toBe('LOCAL-0001')
    expect(isLocalId('PROJ-123')).toBe(false)
  })

  it('TC-U-POLICY-16b mirrored issue filenames are collision-free', () => {
    expect(externalIssueFilename(issue)).toBe('acme__app__412.md')
  })
})

describe('TC-U-POLICY — normalisation helpers', () => {
  it('treats undefined, null and blank as absent', () => {
    expect(normaliseScalar(undefined)).toBeNull()
    expect(normaliseScalar(null)).toBeNull()
    expect(normaliseScalar('   ')).toBeNull()
    expect(normaliseScalar(' value ')).toBe('value')
  })

  it('deduplicates and sorts labels', () => {
    expect(normaliseLabels(['b', 'a', 'b', '  ', ' c '])).toEqual(['a', 'b', 'c'])
  })
})
