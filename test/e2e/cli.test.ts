/**
 * TC-E-FLOW / TC-E-SAFE — docs/testcase/e2e/
 *
 * The CLI is driven in-process through `run()` rather than by spawning a
 * binary: same code path, but a failure points at a line instead of at a
 * process exit code. The tracker is the loopback substitute, so no credential
 * and no network are involved.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { FakeJira } from '../support/fake-jira.js'

let root: string
let jira: FakeJira
let baseUrl: string

function io(over: Partial<Io> = {}): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    stdout,
    stderr,
    out: (l) => stdout.push(l),
    err: (l) => stderr.push(l),
    cwd: root,
    env: { JIRA_PAT: jira.token },
    ...over,
  }
}

async function writeConfig(over: Record<string, string> = {}): Promise<void> {
  await writeFile(
    join(root, 'config.yml'),
    [
      'mgmt:',
      `  schema_version: ${over['schema_version'] ?? '1'}`,
      `  cli_range: "${over['cli_range'] ?? '>=0.1.0 <0.2.0'}"`,
      'jira:',
      `  base_url: "${baseUrl}"`,
      '  project: "PROJ"',
      `  epic_link_field: ${over['epic_link_field'] ?? 'null'}`,
      'github:',
      '  repos: []',
      '',
    ].join('\n'),
    'utf8',
  )
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-e2e-'))
  jira = new FakeJira()
  baseUrl = await jira.start()
})

afterEach(async () => {
  await jira.stop()
  await rm(root, { recursive: true, force: true })
})

describe('TC-E-FLOW — scaffolding', () => {
  it('TC-E-FLOW-01 mgmt init scaffolds a workspace', async () => {
    const o = io()
    expect(await run(['init'], o)).toBe(EXIT.ok)

    for (const path of ['config.yml', '.gitignore', 'CLAUDE.md', '.env.example']) {
      await expect(readFile(join(root, path), 'utf8')).resolves.toBeTypeOf('string')
    }
    for (const dir of ['tickets', 'issues', 'archive', '.sync/base']) {
      await expect(readFile(join(root, dir, '.gitkeep'), 'utf8')).resolves.toBe('')
    }
    await expect(
      readFile(join(root, '.claude/skills/tickets/SKILL.md'), 'utf8'),
    ).resolves.toContain('mgmt status')
  })

  it('TC-E-SAFE-11 mgmt init gitignores .env', async () => {
    await run(['init'], io())

    const ignore = await readFile(join(root, '.gitignore'), 'utf8')
    expect(ignore.split('\n')).toContain('.env')

    // The merge bases must NOT be ignored — a three-way merge across machines
    // depends on them being committed.
    expect(ignore).not.toMatch(/^\.sync\/?$/m)
  })

  it('TC-E-FLOW-01b re-running init keeps existing files', async () => {
    await run(['init'], io())
    await writeFile(join(root, 'config.yml'), '# edited by hand\n', 'utf8')

    const o = io()
    expect(await run(['init'], o)).toBe(EXIT.ok)

    expect(await readFile(join(root, 'config.yml'), 'utf8')).toBe('# edited by hand\n')
    expect(o.stdout.join('\n')).toContain('kept')
  })
})

describe('TC-E-FLOW — doctor', () => {
  it('TC-E-FLOW-02 doctor reports a healthy workspace', async () => {
    await run(['init'], io())
    await writeConfig({ epic_link_field: `"${jira.epicLinkField}"` })

    const o = io()
    expect(await run(['doctor'], o)).toBe(EXIT.ok)

    const out = o.stdout.join('\n')
    expect(out).toContain('Server 9.12.0')
    expect(out).toContain(jira.epicLinkField)
    expect(out).toContain('Workspace is healthy.')
  })

  it('TC-E-FLOW-02b an undiscovered epic link field warns with the id to record', async () => {
    await run(['init'], io())
    await writeConfig()

    const o = io()
    expect(await run(['doctor'], o)).toBe(EXIT.ok) // a warning is not a failure

    expect(o.stdout.join('\n')).toContain(`epic_link_field: ${jira.epicLinkField}`)
  })

  it('TC-E-FLOW-02c a stale epic link field fails rather than writing to the wrong field', async () => {
    await run(['init'], io())
    await writeConfig({ epic_link_field: '"customfield_99999"' })

    const o = io()
    expect(await run(['doctor'], o)).toBe(EXIT.error)
    expect(o.stdout.join('\n')).toContain('Workspace needs attention.')
  })

  it('TC-E-SAFE-13 a missing token names the variable, never a value', async () => {
    await run(['init'], io())
    await writeConfig()

    const o = io({ env: {} })
    expect(await run(['doctor'], o)).toBe(EXIT.error)

    const all = [...o.stdout, ...o.stderr].join('\n')
    expect(all).toContain('JIRA_PAT')
    expect(all).not.toContain(jira.token)
  })

  it('TC-E-SAFE-12 a bad token surfaces without printing the token', async () => {
    await run(['init'], io())
    await writeConfig()

    const o = io({ env: { JIRA_PAT: 'wrong-token-sentinel' } })
    expect(await run(['doctor'], o)).toBe(EXIT.error)

    const all = [...o.stdout, ...o.stderr].join('\n')
    expect(all).not.toContain('wrong-token-sentinel')
    expect(all).toContain('JIRA_PAT')
  })

  it('TC-E-FLOW-14 --json emits parseable output carrying the same result', async () => {
    await run(['init'], io())
    await writeConfig({ epic_link_field: `"${jira.epicLinkField}"` })

    const o = io()
    expect(await run(['--json', 'doctor'], o)).toBe(EXIT.ok)

    const parsed = JSON.parse(o.stdout.join('\n')) as {
      healthy: boolean
      checks: { name: string; status: string }[]
    }
    expect(parsed.healthy).toBe(true)
    expect(parsed.checks.map((c) => c.name)).toContain('epic link field')
  })
})

describe('TC-E-FLOW — workspace discovery', () => {
  it('TC-E-FLOW-12 commands work from a subdirectory', async () => {
    await run(['init'], io())
    await writeConfig({ epic_link_field: `"${jira.epicLinkField}"` })

    const o = io({ cwd: join(root, 'tickets') })
    expect(await run(['doctor'], o)).toBe(EXIT.ok)
  })

  it('TC-E-FLOW-13 outside any workspace, the error points at mgmt init', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'mgmt-none-'))
    try {
      const o = io({ cwd: empty })
      expect(await run(['doctor'], o)).toBe(EXIT.error)
      expect(o.stderr.join('\n')).toContain('mgmt init')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('TC-E-SAFE — version compatibility', () => {
  it('TC-E-SAFE-04 an incompatible CLI refuses to run', async () => {
    await run(['init'], io())
    await writeConfig({ cli_range: '>=9.0.0' })

    const o = io()
    expect(await run(['doctor'], o)).toBe(EXIT.incompatible)
    expect(o.stderr.join('\n')).toMatch(/9\.0\.0/)
  })

  it('TC-E-SAFE-05 the check cannot be bypassed', async () => {
    await run(['init'], io())
    await writeConfig({ cli_range: '>=9.0.0' })

    // There is no flag for this by design; any attempt is rejected as unknown.
    for (const flag of ['--force', '--no-version-check', '--skip-version-check']) {
      const o = io()
      expect(await run([flag, 'doctor'], o)).not.toBe(EXIT.ok)
    }
  })
})
