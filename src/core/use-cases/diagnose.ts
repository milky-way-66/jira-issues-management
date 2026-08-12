/**
 * `mgmt doctor` — check that the workspace can actually talk to the tracker,
 * and surface the instance-specific values that must not be guessed.
 *
 * The point is not "is anything broken" but "which thing is broken, and what do
 * I do about it". Every failed check therefore carries a remedy, because the
 * person reading it is usually setting the tool up for the first time and has
 * no model of what should have happened.
 *
 * Checks are independent and none of them writes. One failure never stops the
 * rest — a run that stopped at the first problem would need four runs to
 * discover four problems.
 */

import type { TicketRepoPort, TrackerHealthPort } from '../ports.js'

export type CheckStatus = 'ok' | 'warn' | 'fail'

export interface Check {
  name: string
  status: CheckStatus
  detail: string
  /** What to do about it. Absent when there is nothing to do. */
  remedy?: string
}

export interface DiagnoseInput {
  repo: TicketRepoPort
  /** Absent when no token is configured — the tracker cannot be reached at all. */
  health: TrackerHealthPort | null
  config: {
    baseUrl: string
    project: string
    /** As recorded in config.yml; null means undiscovered. */
    epicLinkField: string | null
  }
  tokenPresent: boolean
}

export interface Diagnosis {
  checks: Check[]
  /** True when nothing failed. Warnings do not make a workspace unhealthy. */
  healthy: boolean
}

export async function diagnose(input: DiagnoseInput): Promise<Diagnosis> {
  const checks: Check[] = []

  checks.push(await checkWorkspace(input.repo))
  checks.push(checkToken(input.tokenPresent))

  if (input.tokenPresent && input.health) {
    checks.push(await checkServer(input.health, input.config.baseUrl))
    checks.push(await checkEpicLink(input.health, input.config.epicLinkField))
  }

  return { checks, healthy: checks.every((c) => c.status !== 'fail') }
}

async function checkWorkspace(repo: TicketRepoPort): Promise<Check> {
  try {
    const ids = await repo.list()
    return {
      name: 'workspace',
      status: 'ok',
      detail: `${ids.length} ticket${ids.length === 1 ? '' : 's'}`,
    }
  } catch (err) {
    return {
      name: 'workspace',
      status: 'fail',
      detail: (err as Error).message,
      remedy: 'Run `mgmt init` in the directory that should hold the tickets.',
    }
  }
}

function checkToken(present: boolean): Check {
  return present
    ? { name: 'credentials', status: 'ok', detail: 'JIRA_PAT is set' }
    : {
        name: 'credentials',
        status: 'fail',
        detail: 'JIRA_PAT is not set',
        remedy: 'Copy `.env.example` to `.env` and add a personal access token.',
      }
}

async function checkServer(health: TrackerHealthPort, baseUrl: string): Promise<Check> {
  try {
    const info = await health.serverInfo()

    // Cloud speaks a different API version, uses ADF bodies and identifies users
    // by accountId. Pointing this adapter at it fails in confusing ways well
    // after setup, so it is caught here instead.
    if (info.deploymentType.toLowerCase() === 'cloud') {
      return {
        name: 'tracker',
        status: 'fail',
        detail: `${baseUrl} is a Cloud instance (${info.version})`,
        remedy: 'This adapter targets Jira Server / Data Center. Cloud needs a different adapter.',
      }
    }

    return {
      name: 'tracker',
      status: 'ok',
      detail: `${info.deploymentType} ${info.version} at ${baseUrl}`,
    }
  } catch (err) {
    return {
      name: 'tracker',
      status: 'fail',
      detail: (err as Error).message,
      remedy: `Check that ${baseUrl} is reachable and the token is still valid.`,
    }
  }
}

async function checkEpicLink(
  health: TrackerHealthPort,
  configured: string | null,
): Promise<Check> {
  let discovered: string | null
  try {
    discovered = await health.discoverEpicLinkField()
  } catch (err) {
    return {
      name: 'epic link field',
      status: 'warn',
      detail: `could not read the field catalogue: ${(err as Error).message}`,
      remedy: 'Parent links will be skipped until this resolves. Sync is otherwise unaffected.',
    }
  }

  if (discovered === null) {
    return {
      name: 'epic link field',
      status: 'warn',
      detail: 'the instance has no Epic Link field',
      remedy: 'Parent links will not sync. Leave `epic_link_field` null.',
    }
  }

  if (configured === null) {
    return {
      name: 'epic link field',
      status: 'warn',
      detail: `discovered ${discovered}, not yet recorded`,
      remedy: `Set \`jira.epic_link_field: ${discovered}\` in config.yml.`,
    }
  }

  if (configured !== discovered) {
    // A stale id silently writes the parent into whatever field now holds that
    // number — which is worse than not writing it at all.
    return {
      name: 'epic link field',
      status: 'fail',
      detail: `config.yml says ${configured}, the instance says ${discovered}`,
      remedy: `Change \`jira.epic_link_field\` to ${discovered}.`,
    }
  }

  return { name: 'epic link field', status: 'ok', detail: configured }
}
