# TC-I-ENV — the workspace environment

Target: `src/adapters/env-file.ts`, `loadConfig` · Layer: integration

Two things live outside `config.yml`: the token, because it is a secret, and the
tracker's hostname and project key, because they identify a customer and
`config.yml` is committed.

This file specifies both halves. It exists because the first half was documented
long before it worked — the scaffold wrote `.env.example`, the docs said to copy
it, `mgmt doctor` said to put a token in it, and nothing ever read the file.

## Reading `.env`

**TC-I-ENV-01** — `KEY=value` lines become environment entries
**TC-I-ENV-02** — blank lines and `#` comments are ignored
**TC-I-ENV-03** — quoted values keep what quoting is for
**Given** a value wrapped in single or double quotes
**Then** the quotes are stripped and any `#` or trailing space inside is kept.

**TC-I-ENV-04** — an unquoted trailing comment is not part of the value
**Given** `KEY=value # note`
**Then** the value is `value`.

**TC-I-ENV-05** — a `export KEY=value` line is accepted
*People paste these from a shell. Refusing them teaches nothing.*

**TC-I-ENV-06** — the real environment wins over the file
**Given** `JIRA_PAT` set both in the shell and in `.env`
**Then** the shell value is used.

*Rationale: the exported one is the more deliberate of the two, and it is how CI
and a one-off override work.*

**TC-I-ENV-07** — a missing `.env` is not an error
**Then** the environment is unchanged and every command still runs.

*Values may legitimately come entirely from the shell.*

**TC-I-ENV-08** — loading does not mutate `process.env`
**Then** the tokens are visible to the command and to nothing else.

*Rationale: the environment stays an argument rather than a global, which is what
keeps every command drivable in-process from a test.*

## `${VAR}` in `config.yml`

**TC-I-ENV-09** — a `${VAR}` reference is substituted from the environment
**Given** `base_url: "${JIRA_BASE_URL}"` and that variable set in `.env`
**Then** the loaded config holds the real URL.

**TC-I-ENV-10** — an undefined variable fails loudly, naming it
**Then** loading fails with a message naming the variable and where to set it,
**And** it does not substitute an empty string.

*Rationale: an empty substitution produces `base_url: ""`, which surfaces later as
a URL parse error a long way from its cause.*

**TC-I-ENV-11** — a `.env` value is available to `${VAR}` in the same run
**Then** the file is read before the config is parsed.

**TC-I-ENV-12** — text that is not a reference is left alone
**Given** a value containing `$` or `${` without a closing brace
**Then** it passes through unchanged.

**TC-I-ENV-14** — a reference inside a comment is left alone
**Given** `config.yml` documents the feature with `# base_url: "${JIRA_BASE_URL}"`
and that variable is not set
**Then** the file loads, and the comment is untouched.

*Rationale: the scaffolded `config.yml` documents `${VAR}` in exactly that way, so
without this a freshly initialised workspace demands variables it only mentions.*

**TC-I-ENV-15** — a `#` inside a quoted value is not a comment
**Given** `project: "PROJ#${SUFFIX}"`
**Then** the reference after the `#` is still substituted.

## End to end

**TC-I-ENV-13** — a workspace configured entirely through `.env` works
**Given** a `config.yml` whose base URL and project are both `${VAR}` references,
and a `.env` supplying them along with the token
**When** a command that contacts the tracker runs
**Then** it reaches the right instance,
**And** `config.yml` contains no hostname, project key or token.

*This is the arrangement that lets the committed file stay free of anything
identifying, which for a public or shared repository is the difference between
being able to commit it and not.*
