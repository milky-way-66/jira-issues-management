/**
 * The `issues/` directory: a local mirror of the external, read-only source.
 *
 * These files are copies, not tickets. They exist so triage can happen against
 * a diff — "what arrived since last week" is a question git answers well and an
 * API answers badly — and so promotion has something to point at.
 *
 * Because they are copies, they are overwritten wholesale on every pull. Any
 * local edit to a file here is lost, which is why the header says so and why
 * promotion produces a *ticket* rather than editing the mirror in place.
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { externalIssueFilename } from '../core/policy.js'
import type { ExternalIssue } from '../core/ticket.js'

export const ISSUES_DIR = 'issues'

const WARNING =
  '<!-- Mirror of an external issue. Overwritten on every pull; edits here are lost.\n' +
  '     Run `mgmt promote issues/<file>` to turn it into a ticket you can edit. -->'

export class IssueMirror {
  constructor(private readonly root: string) {}

  private path(name: string): string {
    return join(this.root, ISSUES_DIR, name)
  }

  async write(issue: ExternalIssue): Promise<string> {
    const name = externalIssueFilename(issue)
    await mkdir(join(this.root, ISSUES_DIR), { recursive: true })
    await writeFile(this.path(name), serialiseIssue(issue), 'utf8')
    return name
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(join(this.root, ISSUES_DIR)))
        .filter((n) => n.endsWith('.md'))
        .sort()
    } catch {
      return []
    }
  }

  /** Accepts either a bare filename or a workspace-relative path. */
  async read(nameOrPath: string): Promise<ExternalIssue | null> {
    const name = nameOrPath.replace(/^.*\//, '')
    try {
      return parseIssue(await readFile(this.path(name), 'utf8'))
    } catch {
      return null
    }
  }
}

const DELIMITER = '---'

export function serialiseIssue(issue: ExternalIssue): string {
  const front = {
    source: `${issue.owner}/${issue.repo}`,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.author,
    labels: issue.labels,
    created: issue.createdAt,
    updated: issue.updatedAt,
  }

  const yaml = stringifyYaml(front, { lineWidth: 0, defaultStringType: 'QUOTE_DOUBLE' })
  return `${DELIMITER}\n${yaml}${DELIMITER}\n\n${WARNING}\n\n${issue.body.replace(/\s*$/, '')}\n`
}

export function parseIssue(text: string): ExternalIssue {
  const normalised = text.replace(/\r\n/g, '\n')
  const end = normalised.indexOf(`\n${DELIMITER}\n`, DELIMITER.length)
  if (!normalised.startsWith(`${DELIMITER}\n`) || end === -1) {
    throw new Error('not a mirrored issue: missing frontmatter')
  }

  const front = parseYaml(normalised.slice(DELIMITER.length + 1, end + 1)) as Record<string, unknown>
  const [owner = '', repo = ''] = String(front['source'] ?? '').split('/')

  const body = normalised
    .slice(end + DELIMITER.length + 2)
    .replace(/^\n+/, '')
    // The warning is ours, not the author's — it must not travel into a ticket.
    .replace(/^<!-- Mirror of an external issue[\s\S]*?-->\n+/, '')
    .replace(/\s*$/, '')

  return {
    owner,
    repo,
    number: Number(front['number'] ?? 0),
    title: String(front['title'] ?? ''),
    body,
    state: front['state'] === 'closed' ? 'closed' : 'open',
    labels: Array.isArray(front['labels']) ? front['labels'].map(String) : [],
    author: String(front['author'] ?? ''),
    createdAt: String(front['created'] ?? ''),
    updatedAt: String(front['updated'] ?? ''),
  }
}
