# TC-E-SAFE — safety rails

Target: the real `mgmt` binary · Layer: e2e

These cases exist because the failure they prevent is expensive and irreversible:
damaging a shared production tracker, or leaking internal content to an external party.

## Never touch a real system from tests

**TC-E-SAFE-01** — a non-loopback host is refused under test
**Given** `NODE_ENV=test` and a configured base URL that is not loopback
**When** any command that would contact the tracker runs
**Then** it throws before any network call
**And** the message states that tests may only target loopback.

*The whole suite's protection against the day someone points a test run at a live
instance.*

**TC-E-SAFE-01c** — the same refusal protects the external source
**Given** `NODE_ENV=test` and a source base URL that is not loopback
**When** the source is constructed the way the CLI constructs it
**Then** it throws before any network call.

*The tracker is ours to damage; the source belongs to someone else. If only one of
the two were guarded, it should have been this one. The rule lives in a single
module so it cannot hold for one adapter and quietly lapse for the other.*

**TC-E-SAFE-01d** — the guard is armed in the process that is running the tests
**Then** the test-mode detection reports true,
**And** every adapter that can open a socket refuses a public host as a consequence.

*Rationale: both guards are conditional on "are we under test?". If that detection
ever answers no — a runner that sets neither variable, a changed script — the
protection does not fail loudly, it silently stops existing and the suite is free to
reach the internet. This is the case that notices. A suite that needs an external
service also fails for reasons unrelated to the code, and then stops being run.*

**TC-E-SAFE-02** — the suite runs with no real credentials
**Then** the test environment contains no tracker or source token, and every case still
passes.

*If a test needs a real token, it is not a test — it is a manual verification.*

## Never write to the external tracker

**TC-E-SAFE-03** — no non-GET request reaches the external source
**Given** the fake source server rejects and records any non-GET request
**When** the full scenario from TC-E-FLOW runs
**Then** no such request was recorded.

## Version compatibility

**TC-E-SAFE-04** — an incompatible CLI refuses to run
**Given** a workspace whose `cli_range` excludes the installed version
**When** any command runs — including read-only `mgmt status`
**Then** the exit code is 3, nothing is written, and the message states both versions.

**TC-E-SAFE-05** — the check cannot be bypassed
**Then** no flag or environment variable causes the check to be skipped.

*Rationale: an outdated CLI misreading `.sync/base/` corrupts real remote tickets rather
than merely displaying something wrong. An escape hatch here would eventually be used
under time pressure.*

**TC-E-SAFE-06** — `mgmt migrate` raises the schema version in an isolated change
**Then** the only modification is to `config.yml` and any migrated state, and normal
commands work afterwards.

## Blast radius

**TC-E-SAFE-07** — `--limit` caps the tickets touched and says so
**Given** twelve tickets pending and `--limit 10`
**Then** exactly ten are written, and the output states that two were withheld.

**TC-E-SAFE-08** — a partial failure leaves a consistent workspace
**Given** the server fails on the sixth of ten writes
**Then** the first five have updated base snapshots, the rest are untouched, the exit
code is 1, and the next run completes the remainder.

*Rationale: recovery must be "run it again", never "repair the state by hand".*

## Nothing is ever deleted

**TC-E-SAFE-09** — a remote omitting tickets deletes nothing locally
**TC-E-SAFE-10** — archiving moves files, and the content stays retrievable

## Secrets

**TC-E-SAFE-11** — `mgmt init` gitignores `.env`
**TC-E-SAFE-12** — no command prints a token, even at maximum verbosity
**Given** a token set to a recognisable sentinel value
**When** every command runs with verbose output
**Then** the sentinel appears in no stdout or stderr output.

**TC-E-SAFE-13** — an authentication error names the variable, never the value

## Scheduled runs

**TC-E-SAFE-16** — `--scheduled` does nothing while the workspace has it disabled
**Given** `sync.scheduled: false` (the default)
**When** `mgmt sync --apply --scheduled` runs
**Then** no request reaches the tracker, no file is written, and the exit code is **0**.

*Rationale: the cron entry is installed once and left inert, so turning the schedule
on or off is a one-line change in a version-controlled file rather than a crontab edit
nobody else can see. Exit 0 because a disabled schedule is a decision, not a failure —
a nonzero code would page someone every interval.*

**TC-E-SAFE-16b** — enabling it lets the same command through
**TC-E-SAFE-16c** — a manual `mgmt sync --apply` ignores the toggle entirely

*The toggle gates scheduled runs. Blocking a person who typed the command would be
baffling.*

## Repository hygiene

**TC-E-SAFE-14** — the published package contains no project-specific identifiers
**When** the identifier scan runs across sources, templates and documentation
**Then** there are no matches.

**TC-E-SAFE-15** — the package tarball contains only the allowlisted paths
**When** a publish dry-run is inspected
**Then** it contains `dist/`, `templates/` and the readme, and no `.env`, key material,
or test fixture.
