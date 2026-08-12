/**
 * Business rules: value normalisation, the local-only filter, field ownership,
 * and promotion. Pure — no I/O, no clock.
 *
 * Specified by docs/testcase/unit/TC-U-policy.md and TC-U-local-only.md.
 */

import type {
  ExternalIssue,
  FieldName,
  ScalarFieldName,
  TicketDraft,
} from './ticket.js'

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * Absent, null and empty string all mean "no value".
 *
 * YAML round-trips turn one into another. Without this, the tool would detect a
 * change on every run and push a phantom update forever. (TC-U-MERGE-13)
 */
export function normaliseScalar(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null
  const trimmed = v.trim()
  return trimmed === '' ? null : trimmed
}

/**
 * Body comparison ignores trailing whitespace and blank-line padding.
 *
 * The Markdown ↔ tracker-markup round trip is not byte-exact. Comparing raw
 * strings produces an endless stream of phantom diffs in which real changes are
 * invisible. (TC-U-MERGE-14)
 */
export function normaliseBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function normaliseLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  for (const l of labels) {
    const t = l.trim()
    if (t !== '') seen.add(t)
  }
  return [...seen].sort()
}

// ── Local-only blocks ───────────────────────────────────────────────────────

const OPEN = '<!-- local-only -->'
const CLOSE = '<!-- /local-only -->'

export interface LocalOnlyBlock {
  /** The block including both markers. */
  text: string
  /**
   * The last non-empty line before the block, used to put it back in the same
   * place after a pull. Empty when the block starts the document.
   */
  anchor: string
}

/**
 * Removes every local-only block, producing the text that may leave this
 * machine.
 *
 * Every ambiguous case strips MORE, never less. Publishing an internal note
 * cannot be undone; losing a line from a local file can — the local copy is
 * never modified by this function. (TC-U-LOCAL-04/05/06)
 */
export function stripLocalOnly(body: string): string {
  let out = ''
  let rest = body

  for (;;) {
    const open = rest.indexOf(OPEN)
    if (open === -1) break

    out += rest.slice(0, open)
    const afterOpen = open + OPEN.length
    const close = rest.indexOf(CLOSE, afterOpen)

    if (close === -1) {
      // Unclosed: strip to end of document rather than guessing where it ended.
      return normaliseBody(out)
    }

    // A nested opening marker widens the removed span to the outermost close.
    let scanFrom = afterOpen
    let effectiveClose = close
    for (;;) {
      const nested = rest.indexOf(OPEN, scanFrom)
      if (nested === -1 || nested > effectiveClose) break
      const next = rest.indexOf(CLOSE, effectiveClose + CLOSE.length)
      if (next === -1) return normaliseBody(out)
      scanFrom = effectiveClose + CLOSE.length
      effectiveClose = next
    }

    rest = rest.slice(effectiveClose + CLOSE.length)
  }

  // A stray closing marker is inert: drop the marker, keep the text.
  out += rest
  return normaliseBody(out.split(CLOSE).join(''))
}

/** Extracts local-only blocks together with the anchor used to restore them. */
export function extractLocalOnly(body: string): LocalOnlyBlock[] {
  const blocks: LocalOnlyBlock[] = []
  let cursor = 0

  for (;;) {
    const open = body.indexOf(OPEN, cursor)
    if (open === -1) break

    const close = body.indexOf(CLOSE, open + OPEN.length)
    const end = close === -1 ? body.length : close + CLOSE.length

    const before = body.slice(0, open)
    const anchorLine = before
      .split('\n')
      .reverse()
      .find((l) => l.trim() !== '')

    blocks.push({
      text: body.slice(open, end).trim(),
      anchor: anchorLine?.trim() ?? '',
    })

    cursor = end
    if (close === -1) break
  }

  return blocks
}

/**
 * Puts local-only blocks back into a body pulled from the tracker.
 *
 * Without this, applying a remote body would silently delete the user's
 * internal notes on the next sync — the single most likely way to lose data
 * here. (TC-U-LOCAL-08)
 *
 * A block is restored after its anchor line when that line still exists. When
 * the surrounding text has changed enough that the anchor is gone, the block is
 * appended at the end rather than dropped: position is a convenience, the
 * content is not.
 */
export function reinsertLocalOnly(body: string, blocks: readonly LocalOnlyBlock[]): string {
  if (blocks.length === 0) return normaliseBody(body)

  const lines = normaliseBody(body).split('\n')
  const appended: string[] = []

  for (const block of blocks) {
    const at = block.anchor === '' ? -1 : lines.findIndex((l) => l.trim() === block.anchor)
    if (at === -1) {
      appended.push(block.text)
    } else {
      lines.splice(at + 1, 0, '', block.text)
    }
  }

  const result = [...lines, ...appended.flatMap((b) => ['', b])].join('\n')
  return normaliseBody(result)
}

// ── Field ownership ─────────────────────────────────────────────────────────

export type Owner = 'jira' | 'local' | 'none'

/**
 * Which side wins when a conflict is resolved without an explicit `--take`.
 *
 * `none` means the tool refuses to choose: the values are editorial and a wrong
 * automatic pick silently discards someone's writing.
 */
const FIELD_OWNER: Record<FieldName, Owner> = {
  status: 'jira',
  assignee: 'jira',
  type: 'jira',
  parent: 'jira',
  title: 'none',
  body: 'none',
  labels: 'none',
  priority: 'jira',
  estimate: 'none',
  due: 'jira',
}

export function defaultOwner(field: FieldName): Owner {
  return FIELD_OWNER[field]
}

/**
 * Which side wins for a given conflict.
 *
 * An explicit choice always beats the default table: the default encodes "who
 * usually owns this", never "the user may not decide otherwise".
 * (TC-U-POLICY-08)
 */
export function resolveOwner(field: FieldName, take?: 'local' | 'jira'): Owner {
  return take ?? defaultOwner(field)
}

/**
 * Fields the tool will not push automatically even when only the local side
 * changed.
 *
 * Changing issue type after creation frequently fails or silently drops fields,
 * so the tool reports it and lets a human do it deliberately. (TC-U-POLICY-10)
 */
const NEVER_AUTO_PUSH: ReadonlySet<FieldName> = new Set<FieldName>(['type'])

export function isAutoPushable(field: FieldName): boolean {
  return !NEVER_AUTO_PUSH.has(field)
}

export function autoPushRefusal(field: FieldName, from: string | null, to: string | null): string {
  return `${field} changed locally (${from ?? '∅'} → ${to ?? '∅'}) but is never pushed automatically; change it in the tracker if intended`
}

/**
 * Fields the tracker cannot accept as a plain field write.
 *
 * The core states the requirement and carries the target by *name*; resolving a
 * name to an instance-specific transition id belongs to the adapter.
 * (TC-U-POLICY-09)
 */
const REQUIRES_TRANSITION: ReadonlySet<ScalarFieldName> = new Set<ScalarFieldName>(['status'])

export function requiresTransition(field: ScalarFieldName): boolean {
  return REQUIRES_TRANSITION.has(field)
}

// ── Local ids ───────────────────────────────────────────────────────────────

const LOCAL_ID = /^LOCAL-(\d+)$/

export function isLocalId(id: string): boolean {
  return LOCAL_ID.test(id)
}

export function formatLocalId(n: number): string {
  return `LOCAL-${String(n).padStart(4, '0')}`
}

/** Sequential, never random — snapshot tests must be reproducible. */
export function nextLocalId(highest: number): string {
  return formatLocalId(highest + 1)
}

/** The label that makes ticket creation recoverable after a crash. */
export function syncLabel(localId: string): string {
  return `sync-${localId}`
}

// ── Promotion ───────────────────────────────────────────────────────────────

export interface PromoteOptions {
  type?: string
  parent?: string | null
  status?: string
  labels?: string[]
}

/**
 * Turns an external issue into a local draft.
 *
 * The title is carried across verbatim. Translating or reformatting it is a
 * human decision made at triage, not something the tool should do silently.
 * (TC-U-POLICY-15)
 */
export function draftFromExternalIssue(
  issue: ExternalIssue,
  localId: string,
  opts: PromoteOptions = {},
): TicketDraft {
  const labels = normaliseLabels([...(opts.labels ?? []), syncLabel(localId)])

  return {
    localId,
    fields: {
      title: issue.title,
      body: issue.body,
      status: opts.status ?? 'To Do',
      assignee: null,
      type: opts.type ?? 'Task',
      parent: normaliseScalar(opts.parent),
      labels,
      priority: null,
      estimate: null,
      due: null,
    },
    source: { owner: issue.owner, repo: issue.repo, number: issue.number },
  }
}

/** Stable, collision-free filename for a mirrored external issue. */
export function externalIssueFilename(issue: ExternalIssue): string {
  return `${issue.owner}__${issue.repo}__${issue.number}.md`
}
