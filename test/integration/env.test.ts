/**
 * TC-I-ENV — docs/testcase/integration/TC-I-env.md
 *
 * The `.env` half of this was documented long before it worked: the scaffold
 * wrote `.env.example`, the docs said to copy it, `mgmt doctor` said to put a
 * token in it, and nothing read the file. These cases are what makes the
 * documentation true.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EXIT, run, type Io } from '../../src/adapters/cli.js'
import { loadEnv, parseEnvFile } from '../../src/adapters/env-file.js'
import { WorkspaceError, interpolate, loadConfig } from '../../src/adapters/workspace.js'
import { FakeJira } from '../support/fake-jira.js'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mgmt-env-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('TC-I-ENV — reading .env', () => {
  it('TC-I-ENV-01 KEY=value lines become environment entries', () => {
    expect(parseEnvFile('JIRA_PAT=abc123\nOTHER=xyz')).toEqual({
      JIRA_PAT: 'abc123',
      OTHER: 'xyz',
    })
  })

  it('TC-I-ENV-02 blank lines and comments are ignored', () => {
    expect(parseEnvFile('\n# a comment\n\nA=1\n   \n#B=2\n')).toEqual({ A: '1' })
  })

  it('TC-I-ENV-03 quoted values keep what quoting is for', () => {
    expect(parseEnvFile('A="value # not a comment"')).toEqual({ A: 'value # not a comment' })
    expect(parseEnvFile("B='trailing  '")).toEqual({ B: 'trailing  ' })
  })

  it('TC-I-ENV-04 an unquoted trailing comment is not part of the value', () => {
    expect(parseEnvFile('A=value # note')).toEqual({ A: 'value' })
  })

  it('TC-I-ENV-05 an exported line is accepted', () => {
    // People paste these straight from a shell.
    expect(parseEnvFile('export JIRA_PAT=abc')).toEqual({ JIRA_PAT: 'abc' })
  })

  it('TC-I-ENV-06 the real environment wins over the file', async () => {
    await writeFile(join(root, '.env'), 'JIRA_PAT=from-file\nONLY_FILE=yes\n', 'utf8')

    const env = await loadEnv(root, { JIRA_PAT: 'from-shell' })

    // The exported one is the more deliberate of the two, and it is how CI and
    // a one-off override work.
    expect(env['JIRA_PAT']).toBe('from-shell')
    expect(env['ONLY_FILE']).toBe('yes')
  })

  it('TC-I-ENV-07 a missing .env is not an error', async () => {
    const base = { A: '1' }
    await expect(loadEnv(root, base)).resolves.toEqual(base)
  })

  it('TC-I-ENV-08 loading does not mutate process.env', async () => {
    await writeFile(join(root, '.env'), 'MGMT_TEST_SENTINEL=leaked\n', 'utf8')

    await loadEnv(root, {})

    // The environment stays an argument rather than a global — which is what
    // keeps every command drivable in-process from a test.
    expect(process.env['MGMT_TEST_SENTINEL']).toBeUndefined()
  })
})

describe('TC-I-ENV — ${VAR} in config.yml', () => {
  it('TC-I-ENV-09 a reference is substituted from the environment', () => {
    expect(interpolate('url: "${A}/rest"', { A: 'http://x' })).toBe('url: "http://x/rest"')
  })

  it('TC-I-ENV-10 an undefined variable fails loudly, naming it', () => {
    // Substituting an empty string would produce base_url: "" and surface later
    // as a URL parse error a long way from its cause.
    expect(() => interpolate('url: "${NOPE}"', {})).toThrow(/NOPE/)
    expect(() => interpolate('url: "${NOPE}"', {})).toThrow(WorkspaceError)
    expect(() => interpolate('url: "${EMPTY}"', { EMPTY: '' })).toThrow(/EMPTY/)
  })

  it('TC-I-ENV-11 a .env value is available to a reference in the same run', async () => {
    await writeFile(join(root, '.env'), 'JIRA_BASE_URL=http://127.0.0.1:9/x\n', 'utf8')
    await writeFile(
      join(root, 'config.yml'),
      [
        'mgmt:',
        '  schema_version: 1',
        '  cli_range: ">=0.1.0 <1.0.0"',
        'jira:',
        '  base_url: "${JIRA_BASE_URL}"',
        '  project: "PROJ"',
        '',
      ].join('\n'),
      'utf8',
    )

    const env = await loadEnv(root, {})
    const config = await loadConfig(root, env)

    expect(config.jira.base_url).toBe('http://127.0.0.1:9/x')
  })

  it('TC-I-ENV-12 text that is not a reference is left alone', () => {
    expect(interpolate('cost: $5 and ${ not closed', {})).toBe('cost: $5 and ${ not closed')
    expect(interpolate('literal $HOME stays', {})).toBe('literal $HOME stays')
  })
})

describe('TC-I-ENV — a workspace configured entirely through .env', () => {
  it('TC-I-ENV-13 config.yml holds no hostname, project key or token', async () => {
    const jira = new FakeJira()
    const baseUrl = await jira.start()

    try {
      const io: Io & { stdout: string[]; stderr: string[] } = (() => {
        const stdout: string[] = []
        const stderr: string[] = []
        return {
          stdout,
          stderr,
          out: (l: string) => stdout.push(l),
          err: (l: string) => stderr.push(l),
          cwd: root,
          env: {},
        }
      })()

      await run(['init'], io)

      const config = [
        'mgmt:',
        '  schema_version: 1',
        '  cli_range: ">=0.1.0 <1.0.0"',
        'jira:',
        '  base_url: "${JIRA_BASE_URL}"',
        '  project: "${JIRA_PROJECT}"',
        `  epic_link_field: "${jira.epicLinkField}"`,
        '',
      ].join('\n')
      await writeFile(join(root, 'config.yml'), config, 'utf8')
      await writeFile(
        join(root, '.env'),
        [`JIRA_BASE_URL=${baseUrl}`, `JIRA_PROJECT=${jira.project}`, `JIRA_PAT=${jira.token}`, ''].join('\n'),
        'utf8',
      )

      jira.seed({ summary: 'Configured through .env', status: 'To Do' })

      // Note the io still carries an empty env: everything comes from the file.
      const o = { ...io, stdout: [] as string[], stderr: [] as string[] }
      o.out = (l: string) => o.stdout.push(l)
      o.err = (l: string) => o.stderr.push(l)

      expect(await run(['sync'], o), o.stderr.join('\n')).toBe(EXIT.ok)
      expect(o.stdout.join('\n')).toContain('Configured through .env')

      // The committed file names neither the instance nor the project.
      expect(config).not.toContain('127.0.0.1')
      expect(config).not.toContain(jira.token)
      // As a value, that is — "${JIRA_PROJECT}" legitimately contains "PROJ".
      expect(config).not.toContain(`project: "${jira.project}"`)
    } finally {
      await jira.stop()
    }
  })
})
