# TC-E-FLOW — end-to-end sync

Target: the real `mgmt` binary · Layer: e2e
Dependencies: temporary directory, real git, fake HTTP server on loopback

One continuous scenario. Each step depends on the previous one, so they run in order
within a single test.

## Scenario

**TC-E-FLOW-01** — `mgmt init` scaffolds a workspace
**When** `mgmt init` runs in an empty directory
**Then** `config.yml`, `.gitignore`, `.claude/` and empty `tickets/` and `issues/` exist
**And** `.env` is listed in `.gitignore`
**And** the exit code is 0.

**TC-E-FLOW-02** — `mgmt doctor` reports a healthy workspace
**Given** the fake server responds to the server-info and field endpoints
**Then** the output names the detected version and the resolved Epic Link field id
**And** the exit code is 0.

**TC-E-FLOW-03** — `mgmt sync` writes nothing
**Given** the fake server holds three issues and two tickets
**When** `mgmt sync` runs without `--apply`
**Then** the plan is printed
**And** `git status --porcelain` is **empty**
**And** the exit code is 0.

*Asserted through git rather than by inspecting individual files, so it catches writes
anywhere in the workspace — including `.sync/`.*

**TC-E-FLOW-04** — `mgmt sync --apply` materialises the plan
**Then** `tickets/` contains one file per remote ticket with correct frontmatter
**And** `issues/` contains one file per external issue
**And** `.sync/base/` contains one snapshot per ticket
**And** the exit code is 0.

**TC-E-FLOW-05** — a two-sided edit produces exactly one conflict
**Given** `status` is edited locally and changed to a different value on the server
**And** a second ticket is edited only locally
**When** `mgmt sync --apply` runs
**Then** the conflicted ticket has `sync.conflict: true` and conflict markers in its body
**And** the second ticket syncs normally
**And** the exit code is **2**.

**TC-E-FLOW-06** — a conflicted ticket is skipped by later runs
**When** `mgmt sync --apply` runs again with no intervention
**Then** the conflicted file is byte-identical to before
**And** the exit code is still 2.

**TC-E-FLOW-07** — `mgmt resolve --take local` clears the conflict
**Then** markers are gone, `sync.conflict` is false, and the local value is pushed
**And** the following `mgmt sync --apply` reports no conflicts and exits 0.

**TC-E-FLOW-08** — an idle sync is a no-op
**When** `mgmt sync --apply` runs with nothing changed anywhere
**Then** `git status --porcelain` is empty.

*Rationale: this is what makes a scheduled run safe to enable. Without it, cron produces
a commit every interval forever.*

## Promotion

**TC-E-FLOW-09** — promote creates a Jira issue and links both sides
**Given** an untriaged file in `issues/`
**When** `mgmt promote issues/<file> --type Task --parent PROJ-100` then
`mgmt sync --apply` run
**Then** a new ticket file exists carrying both the Jira key and the source issue
reference
**And** the fake server received exactly one create call
**And** the created payload carries the `sync-LOCAL-nnnn` label.

**TC-E-FLOW-10** — an interrupted creation does not duplicate
**Given** the server already holds an issue labelled `sync-LOCAL-0007`, and the local
ticket has no key
**When** `mgmt sync --apply` runs
**Then** no create call is made and the existing key is adopted.

## Repetition

**TC-E-FLOW-11** — twenty consecutive syncs remain stable
**When** `mgmt sync --apply` runs twenty times against an unchanging server
**Then** no ticket is lost, no duplicate is created, cursors advance monotonically
**And** only the first run produces a git diff.

*This is the closest a test gets to the scheduled-run failure mode, where a small
per-run drift compounds unnoticed.*

## Workspace discovery

**TC-E-FLOW-12** — commands work from a subdirectory
**When** `mgmt status` runs from inside `tickets/`
**Then** it resolves the workspace and exits 0.

**TC-E-FLOW-13** — outside any workspace, the error points at `mgmt init`
**Then** the exit code is 1 and the message names `mgmt init`.

## Output contract

**TC-E-FLOW-14** — `--json` emits parseable output carrying the same plan
**Then** stdout parses as JSON and its operations match the human-readable rendering.

*Rationale: an agent consumes this. Mixing log lines into stdout would break it, so the
case also asserts that diagnostics go to stderr.*
