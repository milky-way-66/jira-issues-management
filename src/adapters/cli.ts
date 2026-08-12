/**
 * The command-line surface, and the composition root behind it.
 *
 * Everything here is wiring and presentation. No decision that affects ticket
 * data is made in this file — those live in `core/`, which is what lets the
 * whole sync algorithm be tested without spawning a process.
 *
 * Exit codes are part of the contract (docs/cli.md): 0 success, 1 error,
 * 2 conflicts, 3 version incompatibility. Code 2 exists so a scheduled run can
 * raise conflicts as an alert without reporting the run as failed.
 */

import { Command } from 'commander'
import {
  draftFromExternalIssue,
  formatLocalId,
  nextLocalId,
  syncLabel,
} from '../core/policy.js'
import type { ClockPort } from '../core/ports.js'
import type { Conflict, FieldChange, Instant, SyncPlan, Ticket } from '../core/ticket.js'
import { isLabelsChange } from '../core/ticket.js'
import { diagnose, type Check, type Diagnosis } from '../core/use-cases/diagnose.js'
import {
  ResolveError,
  conflictsFor,
  markResolved,
  resolve,
  type Take,
} from '../core/use-cases/resolve.js'
import {
  TRACKER_CURSOR,
  createPending,
  execute,
  plan,
  type SyncDeps,
} from '../core/use-cases/sync-tickets.js'
import { GithubIssueSource } from './github.js'
import { IssueMirror } from './issue-mirror.js'
import { JiraTracker } from './jira.js'
import { MarkdownTicketRepo } from './markdown-repo.js'
import { refreshTemplates, scaffold } from './scaffold.js'
import {
  CLI_VERSION,
  SCHEMA_VERSION,
  VersionError,
  WorkspaceError,
  findWorkspaceRoot,
  migrate,
  openWorkspace,
  type Workspace,
} from './workspace.js'

export const EXIT = { ok: 0, error: 1, conflicts: 2, incompatible: 3 } as const

export const GITHUB_CURSOR = 'github'

export interface Io {
  out(line: string): void
  err(line: string): void
  cwd: string
  env: Record<string, string | undefined>
}

export const nodeIo: Io = {
  out: (line) => process.stdout.write(line + '\n'),
  err: (line) => process.stderr.write(line + '\n'),
  cwd: process.cwd(),
  env: process.env,
}

/** Real time, injected everywhere so no core code reads the clock directly. */
const systemClock: ClockPort = { now: () => new Date().toISOString() }

/**
 * Builds the parser. Returns an exit code rather than calling `process.exit`,
 * so the whole CLI can be driven from a test in-process.
 */
export async function run(argv: string[], io: Io = nodeIo): Promise<number> {
  const program = new Command()
  let code: number = EXIT.ok

  program
    .name('mgmt')
    .description('Ticket workspace synchronised with an issue tracker')
    .version(CLI_VERSION)
    .option('--workspace <path>', 'workspace root; overrides discovery')
    .option('--json', 'emit machine-readable output')
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s.replace(/\n$/, '')),
      writeErr: (s) => io.err(s.replace(/\n$/, '')),
    })

  const global = () => program.opts()
  const inWorkspace = (fn: (ws: Workspace) => Promise<number>) => async () => {
    code = await withWorkspace(io, global(), fn)
  }

  program
    .command('init')
    .description('scaffold a workspace in the current directory')
    .action(async () => {
      code = await cmdInit(io, (global()['workspace'] as string | undefined) ?? io.cwd)
    })

  program
    .command('doctor')
    .description('check credentials, tracker reachability and instance settings')
    .action(inWorkspace((ws) => cmdDoctor(io, ws, !!global()['json'])))

  program
    .command('sync')
    .description('reconcile local tickets with the tracker (dry run unless --apply)')
    .option('--apply', 'perform the plan instead of previewing it')
    .option('--only <side>', 'restrict to "jira" or "github"')
    .option('--limit <n>', 'cap the number of tickets touched', Number)
    .action(async (opts: { apply?: boolean; only?: string; limit?: number }) => {
      code = await withWorkspace(io, global(), (ws) => cmdSync(io, ws, opts, !!global()['json']))
    })

  program
    .command('pull')
    .argument('<source>', 'currently only "github"')
    .description('mirror external issues into issues/ (read-only)')
    .option('--full', 'full scan rather than incremental')
    .option('--apply', 'write the mirror instead of previewing it')
    .action(async (source: string, opts: { full?: boolean; apply?: boolean }) => {
      code = await withWorkspace(io, global(), (ws) => cmdPull(io, ws, source, opts))
    })

  program
    .command('promote')
    .argument('<file>', 'a file in issues/')
    .description('turn a mirrored external issue into a local ticket')
    .option('--type <type>', 'issue type', 'Task')
    .option('--parent <key>', 'parent or epic key')
    .option('--apply', 'write the ticket instead of previewing it')
    .action(async (file: string, opts: { type: string; parent?: string; apply?: boolean }) => {
      code = await withWorkspace(io, global(), (ws) => cmdPromote(io, ws, file, opts))
    })

  program
    .command('new')
    .argument('<title>')
    .description('create a local ticket, pushed to the tracker on the next sync')
    .option('--type <type>', 'issue type', 'Task')
    .option('--parent <key>', 'parent or epic key')
    .option('--apply', 'write the ticket instead of previewing it')
    .action(async (title: string, opts: { type: string; parent?: string; apply?: boolean }) => {
      code = await withWorkspace(io, global(), (ws) => cmdNew(io, ws, title, opts))
    })

  program
    .command('resolve')
    .argument('<id>')
    .description('settle a conflicted ticket')
    .option('--take <side>', '"local" or "jira"')
    .option('--done', 'the file was edited by hand and is settled')
    .option('--apply', 'record the decision instead of previewing it')
    .action(async (id: string, opts: { take?: string; done?: boolean; apply?: boolean }) => {
      code = await withWorkspace(io, global(), (ws) => cmdResolve(io, ws, id, opts))
    })

  program
    .command('status')
    .description('pending pushes, conflicts and cursor positions')
    .action(inWorkspace((ws) => cmdStatus(io, ws, !!global()['json'])))

  program
    .command('index')
    .description('regenerate INDEX.md')
    .action(inWorkspace((ws) => cmdIndex(io, ws)))

  program
    .command('archive')
    .description('move closed tickets out of the working set (nothing is deleted)')
    .option('--apply', 'perform the move instead of previewing it')
    .action(async (opts: { apply?: boolean }) => {
      code = await withWorkspace(io, global(), (ws) => cmdArchive(io, ws, opts))
    })

  program
    .command('migrate')
    .description('raise the workspace schema version')
    .action(async () => {
      // Runs without the compatibility check: clearing an incompatibility is
      // the entire point, so the check that reports it must not block it.
      code = await cmdMigrate(io, (global()['workspace'] as string | undefined) ?? io.cwd)
    })

  program
    .command('upgrade')
    .description('refresh the agent templates to match the installed CLI')
    .action(
      inWorkspace(async (ws) => {
        for (const path of await refreshTemplates(ws.root)) io.out(`updated ${path}`)
        return EXIT.ok
      }),
    )

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (err) {
    // commander throws for --help and --version too; those are not failures.
    const known = err as { code?: string; exitCode?: number }
    if (
      known.code === 'commander.helpDisplayed' ||
      known.code === 'commander.version' ||
      known.code === 'commander.help'
    ) {
      return EXIT.ok
    }
    io.err(String((err as Error).message ?? err))
    return known.exitCode === 0 ? EXIT.ok : EXIT.error
  }

  return code
}

// ── composition ─────────────────────────────────────────────────────────────

function trackerFor(io: Io, ws: Workspace): JiraTracker {
  const token = io.env['JIRA_PAT']
  if (!token) throw new WorkspaceError('JIRA_PAT is not set. See .env.example.')

  return new JiraTracker({
    baseUrl: ws.config.jira.base_url,
    project: ws.config.jira.project,
    token,
    epicLinkField: ws.config.jira.epic_link_field ?? null,
  })
}

function depsFor(io: Io, ws: Workspace): SyncDeps {
  return {
    repo: new MarkdownTicketRepo(ws.root),
    tracker: trackerFor(io, ws),
    clock: systemClock,
  }
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdInit(io: Io, root: string): Promise<number> {
  const result = await scaffold(root)

  for (const path of result.created) io.out(`created ${path}`)
  for (const path of result.skipped) io.out(`kept    ${path}`)

  if (result.created.length === 0) io.out('\nWorkspace already set up; nothing to do.')
  else io.out('\nNext: copy .env.example to .env, add a token, then run `mgmt doctor`.')

  return EXIT.ok
}

async function cmdMigrate(io: Io, from: string): Promise<number> {
  try {
    const root = await findWorkspaceRoot(from, { env: process.env['MGMT_WORKSPACE'] })
    const result = await migrate(root)

    if (!result) io.out(`Workspace is already at schema version ${SCHEMA_VERSION}.`)
    else io.out(`Migrated schema_version ${result.from} → ${result.to} in config.yml.`)

    return EXIT.ok
  } catch (err) {
    io.err((err as Error).message)
    return err instanceof VersionError ? EXIT.incompatible : EXIT.error
  }
}

async function cmdDoctor(io: Io, ws: Workspace, json: boolean): Promise<number> {
  const token = io.env['JIRA_PAT']

  const diagnosis = await diagnose({
    repo: new MarkdownTicketRepo(ws.root),
    health: token ? trackerFor(io, ws) : null,
    config: {
      baseUrl: ws.config.jira.base_url,
      project: ws.config.jira.project,
      epicLinkField: ws.config.jira.epic_link_field ?? null,
    },
    tokenPresent: !!token,
  })

  if (json) io.out(JSON.stringify(diagnosis, null, 2))
  else renderDiagnosis(io, diagnosis)

  return diagnosis.healthy ? EXIT.ok : EXIT.error
}

async function cmdSync(
  io: Io,
  ws: Workspace,
  opts: { apply?: boolean; only?: string; limit?: number },
  json: boolean,
): Promise<number> {
  if (opts.only && opts.only !== 'jira' && opts.only !== 'github') {
    io.err(`--only accepts "jira" or "github", not "${opts.only}"`)
    return EXIT.error
  }

  const deps = depsFor(io, ws)
  const planned = await plan(deps, {
    ...(opts.only ? { only: opts.only as 'jira' | 'github' } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
  })

  if (!opts.apply) {
    if (json) io.out(JSON.stringify(planned.plan, null, 2))
    else renderPlan(io, planned.plan, false)
    return exitForPlan(planned.plan)
  }

  const result = await execute(deps, planned)

  // Local-only tickets are created after the merge pass, so a creation failure
  // cannot roll back merges that already succeeded.
  const pending = (await deps.repo.list()).filter((id) => id.startsWith('LOCAL-'))
  const creations = await createPending(deps, pending)

  if (json) io.out(JSON.stringify({ ...result, creations }, null, 2))
  else {
    renderPlan(io, result.plan, true)
    for (const { id, key } of creations.created) io.out(`created ${key} for ${id}`)
    for (const { id, key } of creations.adopted) io.out(`adopted ${key} for ${id} (already existed)`)
    for (const failure of result.failures) io.err(`failed  ${failure.id}: ${failure.message}`)
  }

  if (result.failures.length > 0) return EXIT.error
  return exitForPlan(result.plan)
}

async function cmdPull(
  io: Io,
  ws: Workspace,
  sourceName: string,
  opts: { full?: boolean; apply?: boolean },
): Promise<number> {
  if (sourceName !== 'github') {
    io.err(`unknown source "${sourceName}"; the only source is "github"`)
    return EXIT.error
  }

  const repos = (ws.config.github?.repos ?? []).map((spec) => {
    const [owner = '', repo = ''] = spec.split('/')
    return { owner, repo }
  })

  if (repos.length === 0) {
    io.out('No repositories configured under `github.repos`; nothing to pull.')
    return EXIT.ok
  }

  const store = new MarkdownTicketRepo(ws.root)
  const mirror = new IssueMirror(ws.root)
  const source = new GithubIssueSource({ repos, token: io.env['GITHUB_TOKEN'] })

  const cursor = opts.full ? null : await store.getCursor(GITHUB_CURSOR)
  const stream = opts.full ? source.fetchAll() : source.fetchUpdatedSince(cursor)

  let count = 0
  let highWater: Instant | null = null

  for await (const issue of stream) {
    count++
    if (highWater === null || issue.updatedAt > highWater) highWater = issue.updatedAt
    if (opts.apply) io.out(`mirrored ${await mirror.write(issue)}`)
    else io.out(`would mirror ${issue.owner}/${issue.repo}#${issue.number} — ${issue.title}`)
  }

  if (opts.apply && highWater) await store.setCursor(GITHUB_CURSOR, highWater)

  io.out(`\n${count} issue${count === 1 ? '' : 's'}${opts.apply ? ' mirrored' : ' would be mirrored'}.`)
  if (!opts.apply && count > 0) io.out('Re-run with --apply to write them.')

  return EXIT.ok
}

async function cmdPromote(
  io: Io,
  ws: Workspace,
  file: string,
  opts: { type: string; parent?: string; apply?: boolean },
): Promise<number> {
  const mirror = new IssueMirror(ws.root)
  const issue = await mirror.read(file)

  if (!issue) {
    io.err(`no mirrored issue at ${file}. Run \`mgmt pull github --apply\` first.`)
    return EXIT.error
  }

  const store = new MarkdownTicketRepo(ws.root)
  const localId = nextLocalId(await store.highestLocalId())

  const draft = draftFromExternalIssue(issue, localId, {
    type: opts.type,
    parent: opts.parent ?? null,
  })

  if (!opts.apply) {
    io.out(`would create ${localId} — ${draft.fields.title}`)
    io.out(`  type   ${draft.fields.type}`)
    io.out(`  parent ${draft.fields.parent ?? '—'}`)
    io.out(`  source ${issue.owner}/${issue.repo}#${issue.number}`)
    io.out('\nRe-run with --apply to create it.')
    return EXIT.ok
  }

  await store.save({
    id: localId,
    fields: draft.fields,
    github: {
      repo: `${issue.owner}/${issue.repo}`,
      number: issue.number,
      url: '',
      state: issue.state,
      updated: issue.updatedAt,
    },
    sync: { base: null, lastPull: null, lastPush: null, conflict: false },
  })

  io.out(`created ${localId} from ${issue.owner}/${issue.repo}#${issue.number}`)
  io.out('It reaches the tracker on the next `mgmt sync --apply`.')
  return EXIT.ok
}

async function cmdNew(
  io: Io,
  ws: Workspace,
  title: string,
  opts: { type: string; parent?: string; apply?: boolean },
): Promise<number> {
  const store = new MarkdownTicketRepo(ws.root)
  const localId = nextLocalId(await store.highestLocalId())

  if (!opts.apply) {
    io.out(`would create ${localId} — ${title}`)
    io.out('\nRe-run with --apply to create it.')
    return EXIT.ok
  }

  await store.save({
    id: localId,
    fields: {
      title,
      body: '',
      status: 'To Do',
      assignee: null,
      type: opts.type,
      parent: opts.parent ?? null,
      labels: [syncLabel(localId)],
      priority: null,
      estimate: null,
      due: null,
    },
    sync: { base: null, lastPull: null, lastPush: null, conflict: false },
  })

  io.out(`created ${localId}`)
  return EXIT.ok
}

async function cmdResolve(
  io: Io,
  ws: Workspace,
  id: string,
  opts: { take?: string; done?: boolean; apply?: boolean },
): Promise<number> {
  const deps = depsFor(io, ws)

  try {
    if (opts.done) {
      if (!opts.apply) {
        io.out(`would clear the conflict flag on ${id}, keeping the file as it stands`)
        return EXIT.ok
      }
      await markResolved(deps, id)
      io.out(`${id} marked resolved`)
      return EXIT.ok
    }

    if (opts.take !== 'local' && opts.take !== 'jira') {
      io.err('resolve needs --take local, --take jira, or --done')
      return EXIT.error
    }

    const conflicts = await conflictsFor(deps, id)
    if (conflicts.length === 0) {
      io.out(`${id} has no outstanding conflicts.`)
      return EXIT.ok
    }

    if (!opts.apply) {
      renderConflicts(io, id, conflicts, opts.take as Take)
      io.out('\nRe-run with --apply to record it.')
      return EXIT.ok
    }

    const result = await resolve(deps, id, opts.take as Take, conflicts)
    io.out(`${id} resolved, taking ${opts.take}: ${result.applied.join(', ')}`)
    if (result.pendingPush) io.out('The tracker is updated on the next `mgmt sync --apply`.')
    return EXIT.ok
  } catch (err) {
    if (err instanceof ResolveError) {
      io.err(err.message)
      return EXIT.error
    }
    throw err
  }
}

async function cmdStatus(io: Io, ws: Workspace, json: boolean): Promise<number> {
  const store = new MarkdownTicketRepo(ws.root)
  const ids = await store.list()

  const tickets: Ticket[] = []
  const unreadable: string[] = []

  for (const id of ids) {
    try {
      const ticket = await store.load(id)
      if (ticket) tickets.push(ticket)
    } catch (err) {
      // One malformed file must not hide the state of every other ticket.
      unreadable.push(`${id}: ${(err as Error).message}`)
    }
  }

  const conflicted = tickets.filter((t) => t.sync.conflict)
  const unsynced = tickets.filter((t) => !t.jira)

  const summary = {
    tickets: tickets.length,
    conflicted: conflicted.map((t) => t.id),
    awaitingCreation: unsynced.map((t) => t.id),
    unreadable,
    cursors: {
      jira: await store.getCursor(TRACKER_CURSOR),
      github: await store.getCursor(GITHUB_CURSOR),
    },
  }

  if (json) {
    io.out(JSON.stringify(summary, null, 2))
  } else {
    io.out(`${summary.tickets} ticket${summary.tickets === 1 ? '' : 's'}`)
    if (conflicted.length > 0) io.out(`conflicted:        ${summary.conflicted.join(', ')}`)
    if (unsynced.length > 0) io.out(`awaiting creation: ${summary.awaitingCreation.join(', ')}`)
    for (const problem of unreadable) io.err(`unreadable: ${problem}`)
    io.out(`cursor jira:       ${summary.cursors.jira ?? '(never synced)'}`)
    io.out(`cursor github:     ${summary.cursors.github ?? '(never pulled)'}`)
  }

  return conflicted.length > 0 ? EXIT.conflicts : EXIT.ok
}

async function cmdIndex(io: Io, ws: Workspace): Promise<number> {
  const store = new MarkdownTicketRepo(ws.root)
  const rows: string[] = []

  for (const id of await store.list()) {
    let ticket: Ticket | null = null
    try {
      ticket = await store.load(id)
    } catch {
      rows.push(`| ${id} | — | (unreadable) | — |`)
      continue
    }
    if (!ticket) continue
    rows.push(
      `| [${id}](tickets/${id}.md) | ${ticket.fields.type} | ${ticket.fields.status} | ${escapePipes(ticket.fields.title)} |`,
    )
  }

  const content = [
    '# Tickets',
    '',
    '<!-- Generated by `mgmt index`. Edits are overwritten. -->',
    '',
    '| ID | Type | Status | Title |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n')

  const { writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  await writeFile(join(ws.root, 'INDEX.md'), content, 'utf8')

  io.out(`INDEX.md regenerated — ${rows.length} ticket${rows.length === 1 ? '' : 's'}`)
  return EXIT.ok
}

async function cmdArchive(io: Io, ws: Workspace, opts: { apply?: boolean }): Promise<number> {
  const store = new MarkdownTicketRepo(ws.root)
  const closed: string[] = []

  for (const id of await store.list()) {
    let ticket: Ticket | null = null
    try {
      ticket = await store.load(id)
    } catch {
      continue
    }
    if (ticket && /^(done|closed|resolved)$/i.test(ticket.fields.status)) closed.push(id)
  }

  if (closed.length === 0) {
    io.out('Nothing to archive.')
    return EXIT.ok
  }

  for (const id of closed) {
    if (opts.apply) {
      await store.archive(id)
      io.out(`archived ${id}`)
    } else {
      io.out(`would archive ${id}`)
    }
  }

  // Archiving moves files; it never deletes. Say so, because "archive" reads as
  // destructive to anyone who has not read the docs.
  io.out(`\n${closed.length} ticket${closed.length === 1 ? '' : 's'} → archive/ (nothing is deleted)`)
  if (!opts.apply) io.out('Re-run with --apply to move them.')

  return EXIT.ok
}

// ── presentation ────────────────────────────────────────────────────────────

const MARK: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✗' }

function renderDiagnosis(io: Io, diagnosis: Diagnosis): void {
  const width = Math.max(...diagnosis.checks.map((c) => c.name.length))

  for (const check of diagnosis.checks) {
    io.out(`${MARK[check.status]} ${check.name.padEnd(width)}  ${check.detail}`)
    if (check.remedy) io.out(`  ${' '.repeat(width)}  → ${check.remedy}`)
  }

  io.out('')
  io.out(diagnosis.healthy ? 'Workspace is healthy.' : 'Workspace needs attention.')
}

function renderPlan(io: Io, syncPlan: SyncPlan, applied: boolean): void {
  if (syncPlan.tickets.length === 0) {
    io.out(applied ? 'Nothing needed doing.' : 'Everything is in sync; nothing to do.')
    return
  }

  for (const ticket of syncPlan.tickets) {
    io.out(ticket.id)

    for (const change of ticket.pull) {
      io.out(`  ${applied ? 'pulled' : 'pull  '} ${describe(change)}`)
    }
    for (const change of ticket.push) {
      io.out(`  ${applied ? 'pushed' : 'push  '} ${describe(change)}`)
    }
    for (const conflict of ticket.conflicts) {
      io.out(`  CONFLICT ${conflict.field}: local ${show(conflict.local)} / jira ${show(conflict.remote)}`)
    }
    for (const warning of ticket.warnings) io.out(`  ! ${warning}`)
  }

  if (syncPlan.withheld > 0) {
    // Never let a cap read as "everything is in sync".
    io.out(`\n${syncPlan.withheld} further ticket(s) withheld by --limit.`)
  }

  const conflicts = syncPlan.tickets.filter((t) => t.conflicts.length > 0).length
  if (conflicts > 0) {
    io.out(`\n${conflicts} conflict(s) need a decision: mgmt resolve <id> --take local|jira`)
  }
  if (!applied) io.out('\nDry run. Re-run with --apply to perform it.')
}

function renderConflicts(io: Io, id: string, conflicts: readonly Conflict[], take: Take): void {
  io.out(`${id} — taking ${take}:`)
  for (const conflict of conflicts) {
    const winner = take === 'local' ? conflict.local : conflict.remote
    io.out(`  ${conflict.field}`)
    io.out(`    local ${show(conflict.local)}`)
    io.out(`    jira  ${show(conflict.remote)}`)
    io.out(`    →     ${show(winner)}`)
  }
}

function describe(change: FieldChange): string {
  if (isLabelsChange(change)) {
    const parts = [...change.add.map((l) => `+${l}`), ...change.remove.map((l) => `-${l}`)]
    return `labels ${parts.join(' ')}`
  }
  return `${change.field}: ${show(change.from)} → ${show(change.to)}`
}

function show(v: string | string[] | null | undefined): string {
  if (v === null || v === undefined) return '(none)'
  if (Array.isArray(v)) return v.join(', ') || '(none)'
  const oneLine = v.replace(/\s+/g, ' ').trim()
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}...` : oneLine || '(empty)'
}

function escapePipes(s: string): string {
  return s.replace(/\|/g, '\\|')
}

function exitForPlan(syncPlan: SyncPlan): number {
  return syncPlan.tickets.some((t) => t.conflicts.length > 0) ? EXIT.conflicts : EXIT.ok
}

// ── plumbing ────────────────────────────────────────────────────────────────

/**
 * Opens the workspace and maps the failure modes onto their documented exit
 * codes. Version incompatibility gets its own code because automation must be
 * able to tell "the tool is wrong for this data" from "the tracker is down".
 */
async function withWorkspace(
  io: Io,
  opts: Record<string, unknown>,
  fn: (ws: Workspace) => Promise<number>,
): Promise<number> {
  try {
    const ws = await openWorkspace(io.cwd, { explicit: opts['workspace'] as string | undefined })
    return await fn(ws)
  } catch (err) {
    if (err instanceof VersionError) {
      io.err(err.message)
      return EXIT.incompatible
    }
    if (err instanceof WorkspaceError) {
      io.err(err.message)
      return EXIT.error
    }
    io.err((err as Error).message)
    return EXIT.error
  }
}

export { formatLocalId }
