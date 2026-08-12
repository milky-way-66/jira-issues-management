/**
 * TC-I-SERVE — docs/testcase/integration/TC-I-serve.md
 *
 * A real socket, on loopback. No tracker: the move function is a stub, because
 * what is under test here is the boundary, not the transition.
 */

import { afterEach, describe, expect, it } from 'vitest'
import {
  HOST,
  newNonce,
  startBoardServer,
  type RunningBoard,
} from '../../src/adapters/board-server.js'
import type { MoveResult } from '../../src/core/use-cases/move.js'

const NONCE = 'test-nonce-value'

let running: RunningBoard | null = null
let moves: { id: string; to: string }[] = []

afterEach(async () => {
  await running?.close()
  running = null
  moves = []
})

interface ServeOpts {
  apply?: boolean
  nonce?: string
  render?: () => Promise<string>
  move?: (id: string, to: string) => Promise<MoveResult>
}

async function serve(opts: ServeOpts = {}): Promise<RunningBoard> {
  running = await startBoardServer({
    port: 0,
    apply: opts.apply ?? true,
    nonce: opts.nonce ?? NONCE,
    render: opts.render ?? (async () => '<h1>board</h1>'),
    move:
      opts.move ??
      (async (id, to) => {
        moves.push({ id, to })
        return { id, from: 'To Do', to, requested: to, applied: true, unchanged: false }
      }),
  })
  return running
}

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${url}/api/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const authorised = { 'x-mgmt-nonce': NONCE }

describe('serving', () => {
  it('TC-I-SERVE-01 renders the current board on every request', async () => {
    let generation = 0
    const server = await serve({ render: async () => `<h1>board ${++generation}</h1>` })

    expect(await (await fetch(server.url)).text()).toContain('board 1')
    // Re-rendered, not cached: an edit on disk shows on reload.
    expect(await (await fetch(server.url)).text()).toContain('board 2')
  })

  it('TC-I-SERVE-02 binds loopback only', async () => {
    const server = await serve()

    expect(server.url).toMatch(new RegExp(`^http://${HOST}:\\d+$`))
  })

  it('TC-I-SERVE-03 declares a policy that forbids fetching anything', async () => {
    const server = await serve()
    const res = await fetch(server.url)

    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
  })

  it('TC-I-SERVE-04 answers an unknown path with 404', async () => {
    const server = await serve()

    expect((await fetch(`${server.url}/secrets`)).status).toBe(404)
  })

  it('TC-I-SERVE-04b answers HEAD like GET, with no body', async () => {
    const server = await serve()
    const res = await fetch(server.url, { method: 'HEAD' })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(await res.text()).toBe('')
  })
})

describe('writes', () => {
  it('TC-I-SERVE-05 refuses a move with no nonce', async () => {
    const server = await serve()

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' })

    expect(res.status).toBe(403)
    expect(moves).toHaveLength(0)
  })

  it('TC-I-SERVE-06 refuses a move with the wrong nonce', async () => {
    const server = await serve()

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' }, { 'x-mgmt-nonce': 'guessed' })

    expect(res.status).toBe(403)
    expect(moves).toHaveLength(0)
  })

  it('TC-I-SERVE-07 refuses every move on a read-only server', async () => {
    const server = await serve({ apply: false })

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' }, authorised)

    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain('--apply')
    expect(moves).toHaveLength(0)
  })

  it('TC-I-SERVE-08 performs a valid move and returns the result', async () => {
    const server = await serve()

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' }, authorised)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ id: 'PROJ-1', to: 'Done', applied: true })
    expect(moves).toEqual([{ id: 'PROJ-1', to: 'Done' }])
  })

  it('TC-I-SERVE-08b reports where the tracker actually landed it', async () => {
    const server = await serve({
      move: async (id) => ({
        id,
        from: 'To Do',
        to: 'In Review',
        requested: 'Done',
        applied: true,
        unchanged: false,
      }),
    })

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' }, authorised)

    expect(await res.json()).toMatchObject({ to: 'In Review', requested: 'Done' })
  })

  it('TC-I-SERVE-09 passes the tracker refusal through as 409', async () => {
    const server = await serve({
      move: async () => {
        throw new Error('no transition to "Done". Available: In Progress')
      },
    })

    const res = await post(server.url, { id: 'PROJ-1', to: 'Done' }, authorised)

    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toContain('Available: In Progress')
  })

  it('TC-I-SERVE-10 accepts POST only on the move endpoint', async () => {
    const server = await serve()

    const res = await fetch(`${server.url}/api/move`, { method: 'GET' })

    expect(res.status).toBe(405)
  })

  it('TC-I-SERVE-11 rejects a body that is not JSON', async () => {
    const server = await serve()

    expect((await post(server.url, 'not json at all', authorised)).status).toBe(400)
  })

  it('TC-I-SERVE-12 rejects a body missing id or to', async () => {
    const server = await serve()

    expect((await post(server.url, { id: 'PROJ-1' }, authorised)).status).toBe(400)
    expect((await post(server.url, { to: 'Done' }, authorised)).status).toBe(400)
    expect(moves).toHaveLength(0)
  })

  it('TC-I-SERVE-13 refuses an oversized body rather than buffering it', async () => {
    const server = await serve()

    // fetch may see the connection drop rather than the response; either way the
    // move must not happen.
    await post(server.url, { id: 'PROJ-1', to: 'x'.repeat(8192) }, authorised).catch(() => null)

    expect(moves).toHaveLength(0)
  })

  it('TC-I-SERVE-14 issues a different nonce per run', async () => {
    expect(newNonce()).not.toBe(newNonce())
    expect(newNonce().length).toBeGreaterThan(20)
  })
})
