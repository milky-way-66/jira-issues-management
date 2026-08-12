/**
 * Serves the board so a card can be dragged between columns.
 *
 * A board opened as a file cannot move a ticket: a `file://` page has no way to
 * reach Jira, and the only way to give it one would be to write a personal
 * access token into a file in the workspace. That is not a trade worth making
 * for a drag gesture, so the token stays in the process and the page talks to
 * this instead.
 *
 * Three rules hold here:
 *
 *   1. Loopback only. The socket binds 127.0.0.1, so nothing off this machine
 *      can reach it even on a hostile network.
 *   2. A per-run nonce, embedded in the page and required on every write. Any
 *      other program on the machine can reach a loopback port, and a page in
 *      another tab can POST to one; neither can read this page to learn the
 *      nonce.
 *   3. Read-only unless `--apply`. Serving is not consenting to writes, the
 *      same rule the rest of the CLI follows.
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { MoveResult } from '../core/use-cases/move.js'

/** The address is fixed, not configurable. See rule 1. */
export const HOST = '127.0.0.1'

/** Enough to make guessing hopeless; short enough to embed readably. */
export function newNonce(): string {
  return randomBytes(24).toString('base64url')
}

/** A drag is a few dozen bytes. Anything larger is not a move. */
const MAX_BODY = 4096

export interface BoardServerOptions {
  /** 0 asks the operating system for a free port. */
  port: number
  /** Whether a move is allowed to reach the tracker. */
  apply: boolean
  nonce: string
  /** Re-renders the board. Called per request, so edits on disk show on reload. */
  render: () => Promise<string>
  move: (id: string, to: string) => Promise<MoveResult>
  /** Reports a move, so the terminal shows what the browser did. */
  log?: (line: string) => void
}

export interface RunningBoard {
  url: string
  close(): Promise<void>
}

export async function startBoardServer(opts: BoardServerOptions): Promise<RunningBoard> {
  const server = createServer((req, res) => {
    handle(req, res, opts).catch((err: unknown) => {
      json(res, 500, { error: (err as Error).message })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port, HOST, resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : opts.port

  return {
    url: `http://${HOST}:${port}`,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.()
    server.close(() => resolve())
  })
}

async function handle(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  opts: BoardServerOptions,
): Promise<void> {
  const path = (req.url ?? '/').split('?')[0]

  // HEAD answers like GET without a body, so a probe sees the real headers
  // rather than a 404 that suggests nothing is being served.
  if ((req.method === 'GET' || req.method === 'HEAD') && (path === '/' || path === '/index.html')) {
    const html = await opts.render()
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      // The page is generated here and fetches nothing. Say so, so a stray
      // absolute URL in a ticket title cannot quietly become a request.
      'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
      'cache-control': 'no-store',
    })
    res.end(req.method === 'HEAD' ? undefined : html)
    return
  }

  if (path === '/api/move') {
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
    return move(req, res, opts)
  }

  json(res, 404, { error: 'not found' })
}

async function move(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  opts: BoardServerOptions,
): Promise<void> {
  if (req.headers['x-mgmt-nonce'] !== opts.nonce) {
    return json(res, 403, { error: 'bad or missing nonce' })
  }

  if (!opts.apply) {
    return json(res, 403, {
      error:
        'this board is read-only. Restart with `mgmt board --serve --apply` to let a drag move a ticket.',
    })
  }

  let raw: string
  try {
    raw = await readBody(req)
  } catch (err) {
    return json(res, 413, { error: (err as Error).message })
  }

  let body: { id?: unknown; to?: unknown }
  try {
    body = JSON.parse(raw) as { id?: unknown; to?: unknown }
  } catch {
    return json(res, 400, { error: 'body is not JSON' })
  }

  if (typeof body.id !== 'string' || typeof body.to !== 'string') {
    return json(res, 400, { error: 'id and to are required' })
  }

  try {
    const result = await opts.move(body.id, body.to)
    opts.log?.(
      result.unchanged
        ? `${result.id} already ${result.to}`
        : `${result.id}  ${result.from} → ${result.to}`,
    )
    json(res, 200, result)
  } catch (err) {
    // The tracker's own refusal is the useful message here — "no transition to
    // Done. Available: ..." tells the reader exactly what the workflow allows.
    opts.log?.(`${String(body.id)} refused: ${(err as Error).message}`)
    json(res, 409, { error: (err as Error).message })
  }
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk: Buffer) => {
      raw += chunk
      if (raw.length > MAX_BODY) {
        reject(new Error('request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
