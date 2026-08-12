/**
 * Works out whose board "My tasks" is.
 *
 * Three sources, in this order:
 *
 *   1. `MGMT_ME` in the environment or `.env` — an override that always wins,
 *      and the only source that needs no network at all.
 *   2. `.sync/identity.json`, written by a previous run.
 *   3. The tracker, asked once and then cached.
 *
 * Asking the tracker is what makes this correct without setup: the token
 * already knows who it belongs to, and a Jira username often differs from the
 * local one. Caching is what keeps `mgmt board` an offline command from the
 * second run onward.
 *
 * The cache is per-workspace and gitignored, because it names a person, and
 * because a shared value would give every teammate the same "My tasks".
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { IdentityPort } from '../core/ports.js'

export const IDENTITY_FILE = join('.sync', 'identity.json')

export const ME_VAR = 'MGMT_ME'

export type IdentitySource = 'env' | 'cache' | 'tracker'

export interface Identity {
  name: string
  source: IdentitySource
}

async function readCache(root: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await readFile(join(root, IDENTITY_FILE), 'utf8')) as { me?: unknown }
    return typeof raw.me === 'string' && raw.me !== '' ? raw.me : null
  } catch {
    // Absent, unreadable or corrupt is all the same answer: ask again.
    return null
  }
}

async function writeCache(root: string, me: string): Promise<void> {
  const path = join(root, IDENTITY_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ me }, null, 2)}\n`, 'utf8')
}

/**
 * Resolves the current user, caching a tracker answer for next time.
 *
 * Returns null rather than throwing when nothing can be resolved: a board with
 * an empty "My tasks" is still a useful board, and the project view — the part
 * that needs no identity — should not be lost to a tracker being unreachable.
 */
export async function resolveMe(
  root: string,
  env: NodeJS.ProcessEnv,
  tracker: IdentityPort | null,
): Promise<Identity | null> {
  const override = env[ME_VAR]?.trim()
  if (override) return { name: override, source: 'env' }

  const cached = await readCache(root)
  if (cached) return { name: cached, source: 'cache' }

  if (!tracker) return null

  let name: string | null = null
  try {
    name = await tracker.whoAmI()
  } catch {
    // Offline, or a token without permission to read its own account. Neither
    // is a reason to fail a command that is otherwise entirely local.
    return null
  }
  if (!name) return null

  try {
    await writeCache(root, name)
  } catch {
    // A read-only workspace still gets a board; it just asks again next time.
  }

  return { name, source: 'tracker' }
}
