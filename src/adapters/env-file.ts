/**
 * Reads the workspace's `.env`.
 *
 * The scaffold writes `.env.example`, the docs say to copy it, and `mgmt doctor`
 * tells you to put a token in it — so the file has to actually be read. Until
 * this existed it was not, and a correctly filled `.env` still produced
 * "JIRA_PAT is not set".
 *
 * Deliberately not a dotenv dependency: the format used here is the subset that
 * can be explained in a sentence, and a parser for it is shorter than the
 * argument about which library to take on. Anything fancier — command
 * substitution, multi-line values, variable references inside values — is
 * refused by being unsupported rather than half-implemented.
 *
 * The real environment wins over the file. A value exported in a shell, or
 * injected by CI, is the more deliberate of the two.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const ENV_FILE = '.env'

/** Parses `KEY=value` lines. Blank lines and `#` comments are ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue

    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    if (key === '') continue

    let value = line.slice(eq + 1).trim()

    // Quotes are stripped, which is what lets a value keep trailing spaces or a
    // `#` that would otherwise read as a comment.
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }

    out[key] = value
  }

  return out
}

/**
 * Returns `base` overlaid with the workspace's `.env`, without mutating
 * `process.env` — the environment a command sees stays an argument rather than
 * a global, which is what keeps commands drivable in-process from tests.
 */
export async function loadEnv(
  root: string,
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  let text: string
  try {
    text = await readFile(join(root, ENV_FILE), 'utf8')
  } catch {
    return base // no .env is normal: the values may come from the shell
  }

  const fromFile = parseEnvFile(text)
  const merged: NodeJS.ProcessEnv = { ...fromFile }

  // The real environment last, so it wins.
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && value !== '') merged[key] = value
  }

  return merged
}
