# Data format

A workspace is an ordinary git repository. The tool never invents a database.

```
my-workspace/
├── config.yml             non-secret configuration
├── .env                   secrets — gitignored
├── INDEX.md               generated summary table (do not hand-edit)
│
├── tickets/               ★ the canonical local copy — one file per ticket
│   ├── PROJ-123.md
│   └── LOCAL-0007.md      created locally, not yet pushed to Jira
│
├── issues/                external issues awaiting triage (mirror, read-only)
│   └── acme__app__412.md
│
├── archive/               closed tickets older than the retention window
│
├── .claude/               agent skills and permissions (written by `mgmt init`)
│
└── .sync/                 ★ tool state — must be committed
    ├── state.json         cursors and ETags
    ├── base/              remote snapshot at last successful sync
    │   └── PROJ-123.json
    ├── comments/          read-only mirror of Jira comments
    └── index.json
```

`.sync/base/` **must be committed**. Without it there is no way to tell which side
changed, and two-way sync degrades into last-write-wins — which silently loses edits.
See [sync-algorithm.md](sync-algorithm.md).

## File naming: id only, no slug

```
✅ tickets/PROJ-123.md
❌ tickets/PROJ-123-notification-policy.md
```

Summaries change often. A slug in the filename means every retitle is a `git mv` that
breaks history and every internal link. The filename is an **immutable identifier**.

External issues use `<owner>__<repo>__<number>.md` so one workspace can track issues
from several repositories without collisions.

## Ticket file

````markdown
---
# ── identity ──────────────────────────────────
id: PROJ-123                  # canonical id; equals jira.key once pushed
                              # before it exists in Jira: LOCAL-0007
title: "[QA] Review monitoring documentation"

# ── business fields (ownership: see sync-algorithm.md) ──
type: Task                    # Epic | Task | Sub-task
status: In Progress
assignee: alice
parent: PROJ-100
labels: [monitoring, docs-qa]
priority: Medium
estimate: 4h
due: 2026-08-20

# ── remote links ──────────────────────────────
jira:
  key: PROJ-123
  url: https://jira.example.com/browse/PROJ-123
  updated: 2026-08-11T09:00:00+09:00     # remote timestamp at last sync

github:                       # present only if promoted from an external issue
  repo: acme/app
  number: 412
  url: https://github.com/acme/app/issues/412
  state: open
  updated: 2026-08-10T14:22:00+09:00

# ── sync metadata (written by the tool — humans must not edit) ──
sync:
  base: 9f2a1c…               # sha256 of .sync/base/PROJ-123.json
  last_pull: 2026-08-11T09:01:12+09:00
  last_push: 2026-08-11T08:30:00+09:00
  conflict: false
---

## Description

Written in **Markdown**. Converted to Jira wiki markup on push.

## Acceptance Criteria

- [ ] AC-01: …
- [ ] AC-02: …

## Internal notes

<!-- local-only -->
Anything inside a local-only block is NEVER pushed to Jira.
<!-- /local-only -->
````

### `local-only` blocks

Content between `<!-- local-only -->` and `<!-- /local-only -->` is stripped before the
description is sent to Jira. Use it for internal reasoning, cost estimates, or anything
that should not reach an external reader.

Two consequences:

- The local body is deliberately **not** equal to the Jira description, which is why
  sync compares against a base snapshot rather than doing a string equality check.
- Leaking one of these blocks is a confidentiality failure, so it is covered by a
  dedicated test case treated as a security test — see
  [testcase/unit/TC-U-local-only.md](testcase/unit/TC-U-local-only.md).

### Comments

Jira comments are **not** stored in frontmatter. They are mirrored read-only into
`.sync/comments/<id>.json`. Comments are a human conversation stream; syncing them
two-way produces noise and duplicate risk for no benefit.

## `config.yml`

```yaml
mgmt:
  schema_version: 1          # data format version
  cli_range: ">=0.3 <2"      # CLI versions allowed to operate on this workspace

jira:
  base_url: https://jira.example.com
  project: PROJ
  epic_link_field: customfield_10014    # discovered by `mgmt doctor`

github:
  repos:
    - acme/app

sync:
  archive_after_days: 90
```

`schema_version` and `cli_range` are checked **before every command**, including
read-only ones, with no flag to skip. Multiple machines plus a cron job guarantee that
an outdated CLI will eventually meet newer data, and an outdated CLI misreading
`.sync/base/` corrupts real remote tickets rather than merely displaying something odd.

### Keeping the customer out of a committed file

Any value in `config.yml` may be written as `${VAR}` and supplied from `.env`:

```yaml
jira:
  base_url: "${JIRA_BASE_URL}"
  project: "${JIRA_PROJECT}"
```

A hostname and a project key are not secrets, but they are the parts of this file
that identify a customer — and this file is committed. Referencing them keeps the
committed file free of anything identifying, which for a shared or public repository
is the difference between being able to commit it and not.

An undefined variable **fails loudly, naming it**. Substituting an empty string would
produce `base_url: ""`, and the failure would surface later as a URL parse error a long
way from its cause.

## `.env`

```
JIRA_PAT=…                   # Jira Server 8.14+ personal access token (Bearer auth)
GITHUB_TOKEN=…               # read-only scope is sufficient

JIRA_BASE_URL=https://jira.example.com    # optional, if config.yml references it
JIRA_PROJECT=PROJ                          # optional, likewise
```

Never committed. The tool reads it from the workspace root only, and reads it *before*
parsing `config.yml`, so a value defined here is available to a `${VAR}` reference in
the same run.

Anything already exported in your shell wins over the file — that is how CI injects a
token, and how a one-off override works. Loading never mutates the process environment:
the values reach the command that needs them and nothing else.

`KEY=value` per line; `#` comments and blank lines ignored; quotes stripped, which is
how a value keeps a `#` or a trailing space; a pasted `export KEY=value` is accepted.
