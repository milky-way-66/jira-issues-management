/**
 * `mgmt init` — lay out a new workspace from the templates shipped in the
 * package.
 *
 * Two rules govern this:
 *
 *   - It never overwrites. Someone running `init` in an existing workspace is
 *     almost always trying to add what is missing, not to discard what is
 *     there. Overwriting `config.yml` would destroy the only copy of the
 *     instance-specific settings.
 *   - `.gitignore` must list `.env` before anything else exists, so there is no
 *     window in which a token could be committed.
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface ScaffoldResult {
  created: string[]
  skipped: string[]
}

/**
 * Locates `templates/`, which sits at the package root. Resolving from the
 * module URL rather than the working directory is what makes a global install
 * work; walking up is what makes the bundled layout (`dist/main.js`) and the
 * source layout (`src/adapters/scaffold.ts`) both resolve without a build step.
 */
export function templatesDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))

  for (let depth = 0; depth < 5; depth++) {
    const candidate = join(dir, 'templates')
    if (existsSync(join(candidate, 'config.yml'))) return candidate
    dir = dirname(dir)
  }

  throw new Error('templates/ is missing from the installed package')
}

const DIRECTORIES = ['tickets', 'issues', 'archive', '.sync/base']

/** Template file → destination path, in the order they are created. */
const FILES: [string, string][] = [
  ['gitignore', '.gitignore'],
  ['env.example', '.env.example'],
  ['config.yml', 'config.yml'],
  ['CLAUDE.md', 'CLAUDE.md'],
  // Different agent tools look for different filenames; this one points at the
  // other rather than duplicating it, so the two cannot drift apart.
  ['AGENTS.md', 'AGENTS.md'],
]

export async function scaffold(root: string, templates = templatesDir()): Promise<ScaffoldResult> {
  const created: string[] = []
  const skipped: string[] = []

  for (const dir of DIRECTORIES) {
    const path = join(root, dir)
    if (await exists(path)) {
      skipped.push(dir)
      continue
    }
    await mkdir(path, { recursive: true })
    // Git does not track empty directories, so the layout would not survive a
    // clone without these.
    await writeFile(join(path, '.gitkeep'), '', 'utf8')
    created.push(dir)
  }

  for (const [source, dest] of FILES) {
    const path = join(root, dest)
    if (await exists(path)) {
      skipped.push(dest)
      continue
    }
    await writeFile(path, await readFile(join(templates, source), 'utf8'), 'utf8')
    created.push(dest)
  }

  const claude = join(root, '.claude')
  if (await exists(join(claude, 'skills', 'mgmt', 'SKILL.md'))) {
    skipped.push('.claude')
  } else {
    await cp(join(templates, 'claude'), claude, { recursive: true })
    created.push('.claude')
  }

  return { created, skipped }
}

/**
 * Refreshes only the agent-facing templates, which track the CLI's command
 * surface and go stale when it changes. Unlike `scaffold`, this *does*
 * overwrite — but never `config.yml`, which holds settings the user owns.
 */
export async function refreshTemplates(root: string, templates = templatesDir()): Promise<string[]> {
  for (const name of ['CLAUDE.md', 'AGENTS.md']) {
    await writeFile(join(root, name), await readFile(join(templates, name), 'utf8'), 'utf8')
  }
  await cp(join(templates, 'claude'), join(root, '.claude'), { recursive: true, force: true })
  return ['CLAUDE.md', '.claude/skills', '.claude/settings.json']
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
