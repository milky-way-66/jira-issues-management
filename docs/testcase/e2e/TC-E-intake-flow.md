# TC-E-INTAKE — external issue to tracker ticket

Target: the real `mgmt` binary · Layer: e2e

TC-E-FLOW covers the tracker half of the tool with an empty `github.repos`. This
covers the half that starts outside: an issue someone else wrote, mirrored,
promoted by a human, and only then pushed to the tracker.

The two halves are specified separately because they fail differently. The
tracker half fails by writing the wrong thing to our own project. This half fails
by writing *anything at all* to a repository that belongs to someone else — so
every case here runs against a source server that rejects and records any request
that is not a GET.

The source is a local mock (`test/support/fake-github.ts`). The tracker is either
the in-process substitute (default) or a real Jira in Docker — see
`docs/local-jira.md`. The same cases must pass against both; where they do not,
the mapping is wrong, which is the whole reason for running them twice.

## Mirroring

**TC-E-INTAKE-01** — `mgmt pull github` writes nothing
**Given** a configured source repository with open and closed issues
**When** `mgmt pull github` runs without `--apply`
**Then** it lists what would be mirrored and the workspace is unchanged.

**TC-E-INTAKE-02** — `mgmt pull github --apply` mirrors every issue
**Then** `issues/` contains one file per issue, named for owner, repo and number,
**And** each file records the source coordinates and the author.

**TC-E-INTAKE-03** — a pull request is not an issue
**Given** the source returns a pull request among the issues
**Then** no file is created for it.

*The issues endpoint returns pull requests too. Without the filter, every PR
becomes a fake ticket, and nobody notices until the board is full of them.*

**TC-E-INTAKE-04** — paging is followed to the end
**Given** more issues than fit on one page
**Then** every issue is mirrored, not just the first page.

**TC-E-INTAKE-05** — an incremental pull asks only for what changed
**Given** a previous `--apply` pull recorded a cursor
**When** one issue is edited at the source and `mgmt pull github --apply` runs
**Then** the request carries a `since` bound, and the mirror reflects the edit.

**TC-E-INTAKE-06** — `--full` ignores the cursor
**Then** the request carries no `since` bound.

*A full scan exists to observe what an incremental query structurally cannot: an
issue deleted, transferred, or edited without its timestamp moving.*

## Promotion

**TC-E-INTAKE-07** — `mgmt promote` writes nothing without `--apply`
**TC-E-INTAKE-08** — `mgmt promote --apply` creates a local ticket
**Then** the ticket has a local id, the issue's title and body, and a recorded
link back to the source issue,
**And** the mirror file is left unchanged.

*Promotion copies. Editing the mirror in place would be lost on the next pull,
and would also make the local record of someone else's issue disagree with
theirs.*

**TC-E-INTAKE-09** — promoting the same issue twice is refused or distinct
**Then** a second promotion does not silently create a duplicate ticket pointing
at the same source issue.

## Reaching the tracker

**TC-E-INTAKE-10** — a promoted ticket is created in the tracker on sync
**When** `mgmt sync --apply` runs
**Then** the tracker holds an issue with the promoted title,
**And** the local file records the assigned tracker key alongside the source link.

**TC-E-INTAKE-11** — the source link survives the round trip
**When** a later sync runs
**Then** the ticket still records the source issue, and no conflict is raised
about it.

*The link is local metadata: it exists on neither side of the merge, so a sync
that "reconciles" it is wrong by construction.*

## The guarantee

**TC-E-INTAKE-12** — the whole scenario writes nothing to the source
**Then** every request the source server received was a GET,
**And** the server recorded no rejected write.

*Asserted at the wire rather than in the adapter. A guarantee about someone
else's repository should not depend on our own code being the thing under test.*
