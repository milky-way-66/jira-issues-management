/**
 * TC-U-BOARD — docs/testcase/unit/TC-U-board.md
 *
 * Pure: no filesystem, no tracker. Everything here is arrangement.
 */

import { describe, expect, it } from 'vitest'
import { buildBoard, isMine, rankOf } from '../../src/core/use-cases/board.js'
import type { Ticket } from '../../src/core/ticket.js'

const AT = '2026-08-12T09:00:00+09:00'

function ticket(id: string, over: Partial<Ticket['fields']> = {}, rest: Partial<Ticket> = {}): Ticket {
  return {
    id,
    fields: {
      title: `Title of ${id}`,
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
    },
    sync: { base: null, lastPull: null, lastPush: null, conflict: false },
    ...rest,
  }
}

function build(tickets: Ticket[], me: string | null = null, order?: string[]) {
  return buildBoard(tickets, { me, generated: AT, ...(order ? { order } : {}) })
}

const names = (b: ReturnType<typeof build>) => b.columns

describe('columns', () => {
  it('TC-U-BOARD-01 puts one column per distinct status', () => {
    const board = build([
      ticket('PROJ-1'),
      ticket('PROJ-2', { status: 'In Progress' }),
      ticket('PROJ-3'),
    ])

    expect(names(board)).toEqual(['To Do', 'In Progress'])
    expect(board.project.columns[0]!.cards).toHaveLength(2)
    expect(board.project.columns[1]!.cards).toHaveLength(1)
  })

  it('TC-U-BOARD-02 orders recognised statuses from earliest to latest', () => {
    const board = build([
      ticket('PROJ-1', { status: 'Done' }),
      ticket('PROJ-2', { status: 'To Do' }),
      ticket('PROJ-3', { status: 'In Progress' }),
    ])

    expect(names(board)).toEqual(['To Do', 'In Progress', 'Done'])
  })

  it('TC-U-BOARD-02b ranks the common workflow names it claims to', () => {
    expect(rankOf('Backlog')).toBeLessThan(rankOf('In Progress'))
    expect(rankOf('In Progress')).toBeLessThan(rankOf('In Review'))
    expect(rankOf('In Review')).toBeLessThan(rankOf('Done'))
    expect(rankOf('Resolved')).toEqual(rankOf('Closed'))
  })

  it('TC-U-BOARD-03 places an unrecognised status between active and done', () => {
    const board = build([
      ticket('PROJ-1', { status: 'To Do' }),
      ticket('PROJ-2', { status: 'Chờ duyệt' }),
      ticket('PROJ-3', { status: 'Done' }),
    ])

    expect(names(board)).toEqual(['To Do', 'Chờ duyệt', 'Done'])
  })

  it('TC-U-BOARD-04 keeps first-seen order between two unrecognised statuses', () => {
    const tickets = [
      ticket('PROJ-1', { status: 'Chờ duyệt' }),
      ticket('PROJ-2', { status: 'Đang kiểm thử' }),
    ]

    expect(names(build(tickets))).toEqual(['Chờ duyệt', 'Đang kiểm thử'])
    // Same input, same answer — the order must not depend on run order.
    expect(names(build([...tickets]))).toEqual(['Chờ duyệt', 'Đang kiểm thử'])
  })

  it('TC-U-BOARD-05 puts an explicit order first, and ranks the rest after it', () => {
    const board = build(
      [
        ticket('PROJ-1', { status: 'To Do' }),
        ticket('PROJ-2', { status: 'Done' }),
        ticket('PROJ-3', { status: 'In Progress' }),
      ],
      null,
      ['Done', 'To Do'],
    )

    expect(names(board)).toEqual(['Done', 'To Do', 'In Progress'])
  })

  it('TC-U-BOARD-06 renders an explicitly named column that has no cards', () => {
    const board = build([ticket('PROJ-1', { status: 'To Do' })], null, ['To Do', 'Done'])

    expect(names(board)).toEqual(['To Do', 'Done'])
    expect(board.project.columns[1]!.cards).toEqual([])
  })

  it('TC-U-BOARD-07 matches a status to its column ignoring case and space', () => {
    const board = build([ticket('PROJ-1', { status: 'To Do' })], null, [' to do '])

    expect(board.columns).toHaveLength(1)
    expect(board.project.columns[0]!.cards.map((c) => c.id)).toEqual(['PROJ-1'])
  })
})

describe('cards', () => {
  it('TC-U-BOARD-08 orders cards within a column by ticket number', () => {
    const board = build([ticket('PROJ-12'), ticket('PROJ-2'), ticket('PROJ-100')])

    expect(board.project.columns[0]!.cards.map((c) => c.id)).toEqual([
      'PROJ-2',
      'PROJ-12',
      'PROJ-100',
    ])
  })

  it('TC-U-BOARD-09 carries the tracker URL only when the ticket has one', () => {
    const linked = ticket('PROJ-1', {}, {
      jira: { key: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1', updated: AT },
    })
    const board = build([linked, ticket('LOCAL-0002')])
    const cards = board.project.columns[0]!.cards

    expect(cards.find((c) => c.id === 'PROJ-1')!.url).toBe(
      'https://jira.example.com/browse/PROJ-1',
    )
    expect(cards.find((c) => c.id === 'LOCAL-0002')!.url).toBeNull()
  })

  it('TC-U-BOARD-09b builds a link for a ticket whose file records none', () => {
    const pulled = ticket('PROJ-1', {}, {
      jira: { key: 'PROJ-1', url: '', updated: AT },
    })
    const board = buildBoard([pulled], {
      me: null,
      generated: AT,
      browseUrl: (key) => `https://jira.example.com/browse/${key}`,
    })

    expect(board.project.columns[0]!.cards[0]!.url).toBe(
      'https://jira.example.com/browse/PROJ-1',
    )
  })

  it('TC-U-BOARD-09c leaves a ticket with no key unlinked', () => {
    const board = buildBoard([ticket('LOCAL-0001')], {
      me: null,
      generated: AT,
      browseUrl: (key) => `https://jira.example.com/browse/${key}`,
    })

    expect(board.project.columns[0]!.cards[0]!.url).toBeNull()
  })

  it('TC-U-BOARD-10 marks a conflicted ticket on its card', () => {
    const board = build([
      ticket('PROJ-1', {}, { sync: { base: null, lastPull: null, lastPush: null, conflict: true } }),
    ])

    expect(board.project.columns[0]!.cards[0]!.conflict).toBe(true)
  })

  it('TC-U-BOARD-10b carries the fields the board displays', () => {
    const board = build([
      ticket('PROJ-1', {
        type: 'Sub-task',
        parent: 'PROJ-9',
        priority: 'High',
        labels: ['infra', 'sync-LOCAL-0001'],
      }),
    ])
    const card = board.project.columns[0]!.cards[0]!

    expect(card).toMatchObject({
      type: 'Sub-task',
      parent: 'PROJ-9',
      priority: 'High',
      labels: ['infra', 'sync-LOCAL-0001'],
      path: 'tickets/PROJ-1.md',
    })
  })
})

describe('my tasks', () => {
  const workspace = [
    ticket('PROJ-1', { assignee: 'alice' }),
    ticket('PROJ-2', { assignee: 'bob', status: 'In Progress' }),
    ticket('PROJ-3'),
  ]

  it('TC-U-BOARD-11 holds only the tickets assigned to that user', () => {
    const board = build(workspace, 'alice')

    expect(board.mine.total).toBe(1)
    expect(board.mine.columns.flatMap((c) => c.cards).map((c) => c.id)).toEqual(['PROJ-1'])
  })

  it('TC-U-BOARD-12 matches an assignee ignoring case', () => {
    expect(build(workspace, 'Alice').mine.total).toBe(1)
    expect(build(workspace, 'ALICE').mine.total).toBe(1)
  })

  it('TC-U-BOARD-13 never counts an unassigned ticket as mine', () => {
    const unassigned = build(workspace, 'alice').mine.columns.flatMap((c) => c.cards)

    expect(unassigned.some((c) => c.id === 'PROJ-3')).toBe(false)
    expect(isMine({ ...unassigned[0]!, assignee: null }, 'alice')).toBe(false)
  })

  it('TC-U-BOARD-14 leaves the personal view empty when nobody is identified', () => {
    const board = build(workspace, null)

    expect(board.mine.total).toBe(0)
    expect(board.me).toBeNull()
    expect(board.project.total).toBe(3)
  })
})

describe('both views', () => {
  it('TC-U-BOARD-15 gives both views the same columns in the same order', () => {
    const board = build(
      [
        ticket('PROJ-1', { status: 'Done', assignee: 'alice' }),
        ticket('PROJ-2', { status: 'To Do' }),
      ],
      'alice',
    )

    expect(board.mine.columns.map((c) => c.status)).toEqual(
      board.project.columns.map((c) => c.status),
    )
  })

  it('TC-U-BOARD-16 handles an empty workspace', () => {
    const board = build([], 'alice')

    expect(board.columns).toEqual([])
    expect(board.project.total).toBe(0)
    expect(board.mine.total).toBe(0)
  })
})
