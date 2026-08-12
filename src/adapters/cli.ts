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
import { diagnose, type Check, type Diagnosis } from '../core/use-cases/diagnose.js'
import { JiraTracker } from './jira.js'
import { MarkdownTicketRepo } from './markdown-repo.js'
import { refreshTemplates, scaffold } from './scaffold.js'
import {
  CLI_VERSION,
  VersionError,
  WorkspaceError,
  openWorkspace,
  type Workspace,
} from './workspace.js'

export const EXIT = { ok: 0, error: 1, conflicts: 2, incompatible: 3 } as const

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

  program
    .command('init')
    .description('scaffold a workspace in the current directory')
    .action(async () => {
      code = await cmdInit(io, program.opts()['workspace'] ?? io.cwd)
    })

  program
    .command('doctor')
    .description('check credentials, tracker reachability and instance settings')
    .action(async () => {
      code = await withWorkspace(io, program.opts(), (ws) => cmdDoctor(io, ws, !!program.opts()['json']))
    })

  program
    .command('upgrade')
    .description('refresh the agent templates to match the installed CLI')
    .action(async () => {
      code = await withWorkspace(io, program.opts(), async (ws) => {
        for (const path of await refreshTemplates(ws.root)) io.out(`updated ${path}`)
        return EXIT.ok
      })
    })

  try {
    await program.parseAsync(argv, { from: 'user' })
  } catch (err) {
    // commander throws for --help and --version too; those are not failures.
    const known = err as { code?: string; exitCode?: number }
    if (known.code === 'commander.helpDisplayed' || known.code === 'commander.version') {
      return EXIT.ok
    }
    if (known.code === 'commander.help') return EXIT.ok
    io.err(String((err as Error).message ?? err))
    return known.exitCode === 0 ? EXIT.ok : EXIT.error
  }

  return code
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdInit(io: Io, root: string): Promise<number> {
  const result = await scaffold(root)

  for (const path of result.created) io.out(`created ${path}`)
  for (const path of result.skipped) io.out(`kept    ${path}`)

  if (result.created.length === 0) {
    io.out('\nWorkspace already set up; nothing to do.')
  } else {
    io.out('\nNext: copy .env.example to .env, add a token, then run `mgmt doctor`.')
  }
  return EXIT.ok
}

async function cmdDoctor(io: Io, ws: Workspace, json: boolean): Promise<number> {
  const token = io.env['JIRA_PAT']

  const diagnosis = await diagnose({
    repo: new MarkdownTicketRepo(ws.root),
    health: token
      ? new JiraTracker({
          baseUrl: ws.config.jira.base_url,
          project: ws.config.jira.project,
          token,
          epicLinkField: ws.config.jira.epic_link_field ?? null,
        })
      : null,
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

// ── plumbing ────────────────────────────────────────────────────────────────

/**
 * Opens the workspace and maps the two failure modes onto their documented
 * exit codes. Version incompatibility gets its own code because automation must
 * be able to tell "the tool is wrong for this data" from "the tracker is down".
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
