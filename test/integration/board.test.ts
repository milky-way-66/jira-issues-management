/**
 * TC-I-BOARD — docs/testcase/integration/TC-I-board.md
 *
 * The renderer against real strings, and identity resolution against a real
 * temporary directory and the in-process tracker substitute.
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { renderBoardHtml } from '../../src/adapters/board-html.js'
import { IDENTITY_FILE, resolveMe } from '../../src/adapters/identity.js'
import type { IdentityPort } from '../../src/core/ports.js'
import { buildBoard } from '../../src/core/use-cases/board.js'
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

function html(tickets: Ticket[], me: string | null = null): string {
  return renderBoardHtml(buildBoard(tickets, { me, generated: AT }), { project: 'PROJ' })
}

describe('rendering', () => {
  it('TC-I-BOARD-01 escapes markup in a ticket title', () => {
    const out = html([ticket('PROJ-1', { title: '<script>alert(1)</script>' })])

    expect(out).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // The only script element in the file is the one the renderer wrote itself.
    expect(out.match(/<script/g)).toHaveLength(1)
  })

  it('TC-I-BOARD-02 escapes quotes so a title cannot escape an attribute', () => {
    const out = html([ticket('PROJ-1', { title: 'He said "no" & left' })])

    expect(out).toContain('He said &quot;no&quot; &amp; left')
    expect(out).not.toContain('He said "no"')
    // data-find carries the same text, lowercased, and is still well-formed.
    expect(out).toContain('he said &quot;no&quot; &amp; left')
  })

  it('TC-I-BOARD-02b escapes a single quote in an attribute', () => {
    expect(html([ticket('PROJ-1', { title: "won't fix" })])).toContain('won&#39;t fix')
  })

  it('TC-I-BOARD-03 fetches nothing', () => {
    const out = html([
      ticket('PROJ-1', { assignee: 'alice', labels: ['infra'], priority: 'High' }),
    ])

    expect(out).not.toMatch(/<script[^>]+src=/i)
    expect(out).not.toMatch(/<link\b/i)
    expect(out).not.toMatch(/<img\b/i)
    expect(out).not.toMatch(/<iframe\b/i)
    expect(out).not.toMatch(/@import/i)
    expect(out).not.toMatch(/url\(/i)
  })

  it('TC-I-BOARD-04 still links out to the tracker', () => {
    const out = html([
      ticket('PROJ-1', {}, {
        jira: { key: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1', updated: AT },
      }),
    ])

    expect(out).toContain('href="https://jira.example.com/browse/PROJ-1"')
    // A link is not a fetch: nothing loads from that host when the page opens.
    expect(out).not.toMatch(/(src|@import)\s*=?\s*["(]?https?:/i)
  })

  it('TC-I-BOARD-05 puts both boards in one file, with their counts', () => {
    const out = html(
      [ticket('PROJ-1', { assignee: 'alice' }), ticket('PROJ-2')],
      'alice',
    )

    expect(out).toContain('id="project"')
    expect(out).toContain('id="mine"')
    expect(out).toContain('Project tasks<span class="count">2</span>')
    expect(out).toContain('<span class="count">1</span>')
  })

  it('TC-I-BOARD-06 links each card to its own ticket file', () => {
    expect(html([ticket('PROJ-1')])).toContain('href="tickets/PROJ-1.md"')
  })

  it('TC-I-BOARD-07 names who an empty personal board is empty for', () => {
    const out = html([ticket('PROJ-1', { assignee: 'bob' })], 'alice')

    expect(out).toContain('Nothing is assigned to alice')
  })

  it('TC-I-BOARD-08 explains how to fix an unresolved identity', () => {
    const out = html([ticket('PROJ-1')], null)

    expect(out).toContain('MGMT_ME')
  })
})

describe('links and drag state', () => {
  const linked = ticket('PROJ-1', {}, {
    jira: { key: 'PROJ-1', url: 'https://jira.example.com/browse/PROJ-1', updated: AT },
  })

  it('TC-I-BOARD-15 points the title at the tracker, keeping the file one click away', () => {
    const out = html([linked])

    expect(out).toContain(
      '<a class="title" href="https://jira.example.com/browse/PROJ-1" target="_blank"',
    )
    expect(out).toContain('<a class="file" href="tickets/PROJ-1.md">PROJ-1.md</a>')
  })

  it('TC-I-BOARD-15b keeps an unpushed ticket\'s title pointed at its file', () => {
    expect(html([ticket('LOCAL-0001')])).toContain(
      '<a class="title" href="tickets/LOCAL-0001.md">',
    )
  })

  it('TC-I-BOARD-16 marks a file board as unable to move anything', () => {
    const out = html([linked])

    expect(out).toContain('data-live="0"')
    expect(out).toContain('data-nonce=""')
    expect(out).toContain('mgmt board --serve --apply')
  })

  it('TC-I-BOARD-17 marks a served applying board as draggable', () => {
    const out = renderBoardHtml(buildBoard([linked], { me: null, generated: AT }), {
      project: 'PROJ',
      live: { nonce: 'a-nonce', apply: true },
    })

    expect(out).toContain('data-live="1"')
    expect(out).toContain('data-nonce="a-nonce"')
    expect(out).toContain('drag to move')
    expect(out).toContain('draggable="true"')
    expect(out).toContain('data-status="To Do"')
  })

  it('TC-I-BOARD-18 leaves a served board read-only without --apply', () => {
    const out = renderBoardHtml(buildBoard([linked], { me: null, generated: AT }), {
      project: 'PROJ',
      live: { nonce: 'a-nonce', apply: false },
    })

    expect(out).toContain('data-live="0"')
    expect(out).toContain('restart with --apply')
  })
})

describe('identity', () => {
  let root: string
  let asked: number
  let tracker: IdentityPort

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mgmt-identity-'))
    asked = 0
    tracker = {
      whoAmI: async () => {
        asked += 1
        return 'alice'
      },
    }
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function cache(content: string): Promise<void> {
    await mkdir(join(root, '.sync'), { recursive: true })
    await writeFile(join(root, IDENTITY_FILE), content, 'utf8')
  }

  it('TC-I-BOARD-09 lets MGMT_ME win over a cached name', async () => {
    await cache(JSON.stringify({ me: 'bob' }))

    const me = await resolveMe(root, { MGMT_ME: 'alice' }, tracker)

    expect(me).toEqual({ name: 'alice', source: 'env' })
    expect(asked).toBe(0)
  })

  it('TC-I-BOARD-10 uses a cached identity without asking the tracker', async () => {
    await cache(JSON.stringify({ me: 'bob' }))

    expect(await resolveMe(root, {}, tracker)).toEqual({ name: 'bob', source: 'cache' })
    expect(asked).toBe(0)
  })

  it('TC-I-BOARD-11 asks the tracker once and caches the answer', async () => {
    expect(await resolveMe(root, {}, tracker)).toEqual({ name: 'alice', source: 'tracker' })
    expect(JSON.parse(await readFile(join(root, IDENTITY_FILE), 'utf8'))).toEqual({ me: 'alice' })

    expect(await resolveMe(root, {}, tracker)).toEqual({ name: 'alice', source: 'cache' })
    expect(asked).toBe(1)
  })

  it('TC-I-BOARD-12 resolves to nobody when the tracker cannot be reached', async () => {
    const broken: IdentityPort = {
      whoAmI: async () => {
        throw new Error('ECONNREFUSED')
      },
    }

    await expect(resolveMe(root, {}, broken)).resolves.toBeNull()
  })

  it('TC-I-BOARD-12b resolves to nobody when the tracker will not say', async () => {
    await expect(resolveMe(root, {}, { whoAmI: async () => null })).resolves.toBeNull()
  })

  it('TC-I-BOARD-13 treats a corrupt cache as no cache', async () => {
    await cache('{ this is not json')

    expect(await resolveMe(root, {}, tracker)).toEqual({ name: 'alice', source: 'tracker' })
    expect(JSON.parse(await readFile(join(root, IDENTITY_FILE), 'utf8'))).toEqual({ me: 'alice' })
  })

  it('TC-I-BOARD-14 resolves to nobody with no override, cache or tracker', async () => {
    await expect(resolveMe(root, {}, null)).resolves.toBeNull()
  })
})
