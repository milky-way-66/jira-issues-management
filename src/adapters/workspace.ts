/**
 * Locating and loading a workspace.
 *
 * The CLI is installed globally, so it has to find the data. Adapter layer:
 * this is the only place that knows about the filesystem shape.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'

export const WORKSPACE_FILE = 'config.yml'

/** Data format version this build reads and writes. */
export const SCHEMA_VERSION = 1
export const CLI_VERSION = '0.1.0'

const ConfigSchema = z.object({
  mgmt: z.object({
    // Nonnegative rather than positive: an older-than-current version is not a
    // malformed file, it is a workspace awaiting `mgmt migrate`. Rejecting it
    // as invalid YAML would give the wrong instruction at the wrong moment.
    schema_version: z.number().int().nonnegative(),
    cli_range: z.string().min(1),
  }),
  jira: z.object({
    base_url: z.string().url(),
    project: z.string().min(1),
    epic_link_field: z.string().nullable().default(null),
  }),
  github: z
    .object({ repos: z.array(z.string()).default([]) })
    .default({ repos: [] }),
  sync: z
    .object({
      archive_after_days: z.number().int().positive().default(90),
      /**
       * Whether a scheduled run may sync this workspace. Off by default and
       * per-workspace on purpose: only one machine in a team should hold the
       * schedule, and the person who set it up is rarely the person surprised
       * by it. `mgmt sync --scheduled` is a no-op while this is false, so the
       * cron entry can stay installed and inert.
       */
      scheduled: z.boolean().default(false),
    })
    .default({ archive_after_days: 90, scheduled: false }),
})

export type Config = z.infer<typeof ConfigSchema>

export interface Workspace {
  root: string
  config: Config
}

export class WorkspaceError extends Error {}
export class VersionError extends Error {}

/**
 * Walks up from `from` looking for a config file that declares `mgmt:`, the
 * way git locates `.git`. Means every command works from any subdirectory.
 */
export async function findWorkspaceRoot(
  from: string,
  opts: { explicit?: string | undefined; env?: string | undefined } = {},
): Promise<string> {
  const explicit = opts.explicit ?? opts.env
  if (explicit) {
    const root = isAbsolute(explicit) ? explicit : resolve(from, explicit)
    if (!(await hasConfig(root))) {
      throw new WorkspaceError(`no ${WORKSPACE_FILE} with an "mgmt:" section in ${root}`)
    }
    return root
  }

  let dir = resolve(from)
  for (;;) {
    if (await hasConfig(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  throw new WorkspaceError(
    `not inside a workspace (no ${WORKSPACE_FILE} found in ${from} or any parent).\n` +
      `Run "mgmt init" to create one.`,
  )
}

async function hasConfig(dir: string): Promise<boolean> {
  try {
    const text = await readFile(join(dir, WORKSPACE_FILE), 'utf8')
    const doc: unknown = parseYaml(text)
    return typeof doc === 'object' && doc !== null && 'mgmt' in doc
  } catch {
    return false
  }
}

export async function loadConfig(root: string): Promise<Config> {
  const path = join(root, WORKSPACE_FILE)
  let raw: unknown
  try {
    raw = parseYaml(await readFile(path, 'utf8'))
  } catch (err) {
    throw new WorkspaceError(`cannot read ${path}: ${(err as Error).message}`)
  }

  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new WorkspaceError(`invalid ${path}:\n${detail}`)
  }
  return parsed.data
}

/**
 * Refuses to run when the CLI and the workspace disagree about the data format.
 *
 * Checked before every command, including read-only ones, with no flag to skip.
 * Several machines plus a scheduled job guarantee an outdated CLI will meet
 * newer data eventually, and an outdated CLI misreading base snapshots corrupts
 * real tickets rather than merely displaying something odd. An escape hatch
 * here would be used under time pressure, which is exactly the wrong moment.
 */
export function assertCompatible(config: Config, cliVersion = CLI_VERSION): void {
  if (config.mgmt.schema_version > SCHEMA_VERSION) {
    throw new VersionError(
      `workspace uses schema_version ${config.mgmt.schema_version}, this CLI (${cliVersion}) understands ${SCHEMA_VERSION}.\n` +
        `Upgrade the CLI: npm i -g jira-issues-management`,
    )
  }
  if (config.mgmt.schema_version < SCHEMA_VERSION) {
    throw new VersionError(
      `workspace uses schema_version ${config.mgmt.schema_version}, this CLI expects ${SCHEMA_VERSION}.\n` +
        `Run "mgmt migrate" to upgrade the workspace.`,
    )
  }
  if (!satisfiesRange(cliVersion, config.mgmt.cli_range)) {
    throw new VersionError(
      `CLI ${cliVersion} is outside the range "${config.mgmt.cli_range}" this workspace allows.`,
    )
  }
}

/**
 * Minimal semver range check covering the comparator forms used in cli_range
 * (`>=0.3 <2`). Deliberately not a general semver implementation — a dependency
 * for this would be more surface area than the feature is worth.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version)
  if (!v) return false

  return range
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((comparator) => {
      const m = comparator.match(/^(>=|<=|>|<|=)?(.+)$/)
      if (!m) return false
      const bound = parseVersion(m[2] ?? '')
      if (!bound) return false
      const cmp = compare(v, bound)
      switch (m[1]) {
        case '>':
          return cmp > 0
        case '<':
          return cmp < 0
        case '<=':
          return cmp <= 0
        case '=':
        case undefined:
          return cmp === 0
        default:
          return cmp >= 0
      }
    })
}

function parseVersion(s: string): [number, number, number] | null {
  const m = s.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/)
  if (!m) return null
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)]
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Raises the workspace schema version.
 *
 * Deliberately a text edit rather than a parse-and-reserialise: reserialising
 * would reformat the file and drop every comment, burying the one line that
 * changed in a wholesale rewrite. A migration must be reviewable as a diff.
 *
 * It is also the one command that must run *without* the compatibility check,
 * since its whole purpose is to clear an incompatibility.
 */
export async function migrate(root: string): Promise<{ from: number; to: number } | null> {
  const path = join(root, WORKSPACE_FILE)
  const text = await readFile(path, 'utf8')

  const match = text.match(/^(\s*schema_version:\s*)(\d+)\s*$/m)
  if (!match) throw new WorkspaceError(`${path}: no schema_version to migrate`)

  const from = Number(match[2])
  if (from === SCHEMA_VERSION) return null
  if (from > SCHEMA_VERSION) {
    throw new VersionError(
      `workspace schema ${from} is newer than this CLI understands (${SCHEMA_VERSION}). Upgrade the CLI instead.`,
    )
  }

  await writeFile(path, text.replace(match[0], `${match[1]}${SCHEMA_VERSION}`), 'utf8')
  return { from, to: SCHEMA_VERSION }
}

export async function openWorkspace(
  cwd: string,
  opts: { explicit?: string | undefined } = {},
): Promise<Workspace> {
  const root = await findWorkspaceRoot(cwd, {
    explicit: opts.explicit,
    env: process.env['MGMT_WORKSPACE'],
  })
  const config = await loadConfig(root)
  assertCompatible(config)
  return { root, config }
}
