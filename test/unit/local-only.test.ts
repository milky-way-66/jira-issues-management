/**
 * TC-U-LOCAL — docs/testcase/unit/TC-U-local-only.md
 *
 * Treated as a security test: a leak here sends internal notes to an external
 * system and cannot be undone by a later fix.
 */

import { describe, expect, it } from 'vitest'
import {
  extractLocalOnly,
  reinsertLocalOnly,
  stripLocalOnly,
} from '../../src/core/policy.js'
import { merge3 } from '../../src/core/merge3.js'
import { isEmptyPlan, type FieldSet } from '../../src/core/ticket.js'

const SECRET = 'INTERNAL-ONLY-SENTINEL'

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

describe('TC-U-LOCAL — stripping', () => {
  it('TC-U-LOCAL-01 removes a block and both markers', () => {
    const body = `Visible.\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->\n`
    const out = stripLocalOnly(body)
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('local-only')
    expect(out).toContain('Visible.')
  })

  it('TC-U-LOCAL-02 removes every block', () => {
    const body = [
      'A',
      `<!-- local-only -->${SECRET}1<!-- /local-only -->`,
      'B',
      `<!-- local-only -->${SECRET}2<!-- /local-only -->`,
      'C',
      `<!-- local-only -->${SECRET}3<!-- /local-only -->`,
    ].join('\n\n')

    const out = stripLocalOnly(body)
    expect(out).not.toContain(SECRET)
    expect(out).toContain('A')
    expect(out).toContain('B')
    expect(out).toContain('C')
  })

  it('TC-U-LOCAL-03 preserves surrounding text without blank-line drift', () => {
    const body = `Before.\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->\n\nAfter.`
    expect(stripLocalOnly(body)).toBe('Before.\n\nAfter.')
  })
})

describe('TC-U-LOCAL — malformed input fails closed', () => {
  it('TC-U-LOCAL-04 an unclosed block strips to end of document', () => {
    const body = `Visible.\n\n<!-- local-only -->\n${SECRET}\nmore secret text`
    const out = stripLocalOnly(body)
    expect(out).toBe('Visible.')
    expect(out).not.toContain(SECRET)
  })

  it('TC-U-LOCAL-05 a stray closing marker is inert', () => {
    const body = 'Visible.\n\n<!-- /local-only -->\n\nAlso visible.'
    const out = stripLocalOnly(body)
    expect(out).toContain('Visible.')
    expect(out).toContain('Also visible.')
    expect(out).not.toContain('local-only')
  })

  it('TC-U-LOCAL-06 nested markers strip the outermost span', () => {
    const body = `A\n<!-- local-only -->\n${SECRET}\n<!-- local-only -->\ndeeper\n<!-- /local-only -->\nstill secret\n<!-- /local-only -->\nB`
    const out = stripLocalOnly(body)
    expect(out).not.toContain(SECRET)
    expect(out).not.toContain('deeper')
    expect(out).not.toContain('still secret')
    expect(out).toContain('A')
    expect(out).toContain('B')
  })

  it('TC-U-LOCAL-06b an unclosed nested block strips to end of document', () => {
    const body = `A\n<!-- local-only -->\n${SECRET}\n<!-- local-only -->\ndeeper\n<!-- /local-only -->\ntrailing secret`
    const out = stripLocalOnly(body)
    expect(out).toBe('A')
  })
})

describe('TC-U-LOCAL — round trip', () => {
  it('TC-U-LOCAL-07 stripping never mutates the input', () => {
    const body = `X\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->`
    const copy = body.slice()
    stripLocalOnly(body)
    expect(body).toBe(copy)
  })

  it('TC-U-LOCAL-08 a pulled remote body preserves local-only blocks in place', () => {
    const localBody = [
      '## Description',
      '',
      'Old public text.',
      '',
      '## Internal notes',
      '',
      `<!-- local-only -->\n${SECRET}\n<!-- /local-only -->`,
    ].join('\n')

    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ body: '## Description\n\nOld public text.\n\n## Internal notes' }),
      local: fields({ body: localBody }),
      remote: fields({ body: '## Description\n\nNEW public text.\n\n## Internal notes' }),
    })

    expect(plan.pull).toHaveLength(1)
    const pulled = plan.pull[0]
    if (!pulled || pulled.field !== 'body') throw new Error('expected a body pull')

    expect(pulled.to).toContain(SECRET)
    expect(pulled.to).toContain('NEW public text.')
    expect(pulled.to).not.toContain('Old public text.')

    // Still under its own heading, not relocated to the end.
    const text = pulled.to ?? ''
    expect(text.indexOf('## Internal notes')).toBeLessThan(text.indexOf(SECRET))
  })

  it('TC-U-LOCAL-08b a block whose anchor vanished is kept, not dropped', () => {
    const blocks = extractLocalOnly(
      `## Gone heading\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->`,
    )
    const out = reinsertLocalOnly('Completely different remote body.', blocks)

    expect(out).toContain(SECRET)
    expect(out).toContain('Completely different remote body.')
  })

  it('TC-U-LOCAL-08c a block at the very start of a document is restored', () => {
    const blocks = extractLocalOnly(`<!-- local-only -->\n${SECRET}\n<!-- /local-only -->\n\nRest.`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.anchor).toBe('')
    expect(reinsertLocalOnly('Remote body.', blocks)).toContain(SECRET)
  })

  it('TC-U-LOCAL-08d reinserting nothing leaves the body alone', () => {
    expect(reinsertLocalOnly('Remote body.', [])).toBe('Remote body.')
  })

  it('TC-U-LOCAL-08e an unclosed block is still extracted', () => {
    const blocks = extractLocalOnly(`A\n<!-- local-only -->\n${SECRET}`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.text).toContain(SECRET)
  })
})

describe('TC-U-LOCAL — interaction with merge', () => {
  it('TC-U-LOCAL-09 an edit confined to a local-only block triggers no push', () => {
    const shared = '## Description\n\nPublic text.'
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ body: shared }),
      local: fields({ body: `${shared}\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->` }),
      remote: fields({ body: shared }),
    })

    expect(plan.push).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('TC-U-LOCAL-10 comparison uses the stripped projection', () => {
    const shared = 'Public text.'
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ body: shared }),
      local: fields({ body: `${shared}\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->` }),
      remote: fields({ body: shared }),
    })
    expect(isEmptyPlan(plan)).toBe(true)
  })

  it('TC-U-LOCAL-10b a pushed body never carries local-only content', () => {
    const plan = merge3({
      id: 'PROJ-1',
      base: fields({ body: 'Old.' }),
      local: fields({ body: `New public.\n\n<!-- local-only -->\n${SECRET}\n<!-- /local-only -->` }),
      remote: fields({ body: 'Old.' }),
    })

    expect(JSON.stringify(plan)).not.toContain(SECRET)
    expect(plan.push).toEqual([{ field: 'body', from: 'Old.', to: 'New public.' }])
  })
})
