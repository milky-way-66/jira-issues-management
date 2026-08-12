/**
 * TC-U-MERGE — docs/testcase/unit/TC-U-merge3.md
 *
 * Pure function, no mocks. Test ids map one-to-one onto the specification so a
 * failure names the rule it broke.
 */

import { describe, expect, it } from 'vitest'
import { merge3 } from '../../src/core/merge3.js'
import { isEmptyPlan, type FieldSet, type TicketPlan } from '../../src/core/ticket.js'

function fields(over: Partial<FieldSet> = {}): FieldSet {
  return {
    title: 'Review monitoring documentation',
    body: '## Description\n\nOriginal text.',
    status: 'To Do',
    assignee: 'alice',
    type: 'Task',
    parent: null,
    labels: [],
    priority: 'Medium',
    estimate: null,
    due: null,
    ...over,
  }
}

function run(
  base: Partial<FieldSet> | null,
  local: Partial<FieldSet>,
  remote: Partial<FieldSet>,
): TicketPlan {
  return merge3({
    id: 'PROJ-123',
    base: base === null ? null : fields(base),
    local: fields(local),
    remote: fields(remote),
  })
}

describe('TC-U-MERGE — decision table', () => {
  it('TC-U-MERGE-01 nothing changed anywhere', () => {
    const plan = run({ status: 'To Do' }, { status: 'To Do' }, { status: 'To Do' })
    expect(isEmptyPlan(plan)).toBe(true)
  })

  it('TC-U-MERGE-02 remote changed only → pull', () => {
    const plan = run({ status: 'To Do' }, { status: 'To Do' }, { status: 'In Progress' })
    expect(plan.pull).toEqual([{ field: 'status', from: 'To Do', to: 'In Progress' }])
    expect(plan.push).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('TC-U-MERGE-03 local changed only → push', () => {
    const plan = run({ status: 'To Do' }, { status: 'In Progress' }, { status: 'To Do' })
    expect(plan.push).toEqual([
      { field: 'status', from: 'To Do', to: 'In Progress', viaTransition: true },
    ])
    expect(plan.pull).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('TC-U-MERGE-04 both changed to the same value → base update only', () => {
    const plan = run({ status: 'To Do' }, { status: 'Done' }, { status: 'Done' })
    expect(plan.pull).toEqual([])
    expect(plan.push).toEqual([])
    expect(plan.conflicts).toEqual([])
    expect(plan.baseUpdateOnly).toBe(true)
  })

  it('TC-U-MERGE-05 both changed differently → conflict', () => {
    const plan = run({ status: 'To Do' }, { status: 'In Progress' }, { status: 'In Review' })
    expect(plan.conflicts).toEqual([
      { field: 'status', base: 'To Do', local: 'In Progress', remote: 'In Review' },
    ])
    expect(plan.pull).toEqual([])
    expect(plan.push).toEqual([])
  })
})

describe('TC-U-MERGE — field independence', () => {
  it('TC-U-MERGE-06 decides each field separately', () => {
    const plan = run(
      { status: 'To Do', assignee: 'alice' },
      { status: 'To Do', assignee: 'bob' },
      { status: 'In Progress', assignee: 'alice' },
    )
    expect(plan.pull).toEqual([{ field: 'status', from: 'To Do', to: 'In Progress' }])
    expect(plan.push).toEqual([{ field: 'assignee', from: 'alice', to: 'bob' }])
    expect(plan.conflicts).toEqual([])
  })

  it('TC-U-MERGE-07 a conflict on one field does not suppress another', () => {
    const plan = run(
      { status: 'To Do', title: 'Old' },
      { status: 'In Progress', title: 'New local' },
      { status: 'In Review', title: 'Old' },
    )
    expect(plan.conflicts.map((c) => c.field)).toEqual(['status'])
    expect(plan.push).toEqual([{ field: 'title', from: 'Old', to: 'New local' }])
  })
})

describe('TC-U-MERGE — missing base', () => {
  it('TC-U-MERGE-08 no base, sides identical → nothing to do', () => {
    const plan = run(null, { status: 'To Do' }, { status: 'To Do' })
    expect(isEmptyPlan(plan)).toBe(true)
  })

  it('TC-U-MERGE-09 no base, sides differ → conflict, never a guess', () => {
    const plan = run(null, { status: 'To Do' }, { status: 'Done' })
    expect(plan.conflicts).toEqual([
      { field: 'status', base: null, local: 'To Do', remote: 'Done' },
    ])
    expect(plan.pull).toEqual([])
    expect(plan.push).toEqual([])
  })
})

describe('TC-U-MERGE — labels', () => {
  it('TC-U-MERGE-10 merges as a set, expressed as add/remove', () => {
    const plan = run({ labels: ['a', 'b'] }, { labels: ['a', 'b', 'c'] }, { labels: ['a'] })

    expect(plan.push).toEqual([{ field: 'labels', add: ['c'], remove: [] }])
    expect(plan.pull).toEqual([{ field: 'labels', add: [], remove: ['b'] }])
    expect(plan.conflicts).toEqual([])
  })

  it('TC-U-MERGE-11 identical additions on both sides converge', () => {
    const plan = run({ labels: ['a'] }, { labels: ['a', 'b'] }, { labels: ['a', 'b'] })
    expect(plan.push).toEqual([])
    expect(plan.pull).toEqual([])
    expect(plan.baseUpdateOnly).toBe(true)
  })

  it('TC-U-MERGE-11b no base, differing labels → conflict', () => {
    const plan = run(null, { labels: ['a'] }, { labels: ['b'] })
    expect(plan.conflicts).toEqual([
      { field: 'labels', base: null, local: ['a'], remote: ['b'] },
    ])
  })

  it('TC-U-MERGE-11c no base, identical labels → nothing', () => {
    const plan = run(null, { labels: ['b', 'a'] }, { labels: ['a', 'b'] })
    expect(isEmptyPlan(plan)).toBe(true)
  })
})

describe('TC-U-MERGE — absent and empty values', () => {
  it('TC-U-MERGE-12 clearing a field locally is a real change', () => {
    const plan = run({ assignee: 'alice' }, { assignee: null }, { assignee: 'alice' })
    expect(plan.push).toEqual([{ field: 'assignee', from: 'alice', to: null }])
  })

  it('TC-U-MERGE-13 empty string and null normalise to the same absent value', () => {
    const plan = run({ due: null }, { due: '' }, { due: null })
    expect(isEmptyPlan(plan)).toBe(true)
  })
})

describe('TC-U-MERGE — body', () => {
  it('TC-U-MERGE-14 whitespace-only differences are not changes', () => {
    const plan = run(
      { body: '## Description\n\nText.' },
      { body: '## Description   \n\nText.  \n\n\n' },
      { body: '## Description\n\nText.' },
    )
    expect(isEmptyPlan(plan)).toBe(true)
  })

  it('TC-U-MERGE-15 a real edit on both sides conflicts and carries both texts', () => {
    const plan = run(
      { body: 'base text' },
      { body: 'local text' },
      { body: 'remote text' },
    )
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0]).toMatchObject({
      field: 'body',
      local: 'local text',
      remote: 'remote text',
    })
  })

  it('TC-U-MERGE-15b a remote-only body edit pulls', () => {
    const plan = run({ body: 'same' }, { body: 'same' }, { body: 'updated remotely' })
    expect(plan.pull).toEqual([
      { field: 'body', from: 'same', to: 'updated remotely' },
    ])
  })
})

describe('TC-U-MERGE — plan shape', () => {
  it('TC-U-MERGE-16 the plan is serialisable', () => {
    const plan = run(
      { status: 'To Do', labels: ['a'] },
      { status: 'In Progress', labels: ['a', 'b'] },
      { status: 'In Review', labels: ['a'] },
    )
    expect(JSON.parse(JSON.stringify(plan))).toEqual(plan)
  })

  it('TC-U-MERGE-17 merge performs no I/O', async () => {
    // Structurally guaranteed by the dependency rule; asserted here so a
    // refactor that introduces a side effect fails loudly.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../src/core/merge3.ts', import.meta.url), 'utf8'),
    )
    expect(source).not.toMatch(/require\(|from ['"]node:/)
    expect(source).not.toMatch(/Date\.now|Math\.random|new Date\(/)
  })
})
