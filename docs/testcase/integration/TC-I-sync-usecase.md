# TC-I-SYNC — the sync use case

Target: `core/use-cases/sync-tickets.ts` · Layer: integration
Dependencies: `adapters/in-memory.ts` only — no network, no real filesystem

Every port is backed by a `Map`. Time comes from a pinned `ClockPort`. These cases
verify orchestration: what the use case decides, in what order, and what it refuses.

## Dry-run

**TC-I-SYNC-01** — dry-run performs no writes
**Given** a workspace with pending pushes and pending pulls
**When** `syncTickets({ apply: false })` runs
**Then** a non-empty `SyncPlan` is returned
**And** the in-memory tracker recorded **zero** write calls
**And** the in-memory repository recorded **zero** saves — including base snapshots and
cursors.

*The single most important case in this file. It is the guarantee behind every safety
claim in the CLI documentation.*

**TC-I-SYNC-02** — apply executes exactly the plan that was previewed
**Given** a plan produced with `apply: false`
**When** the same inputs are run with `apply: true`
**Then** the executed operations correspond one-to-one with the previewed plan.

## Ordering

**TC-I-SYNC-03** — pull happens before push
**When** a sync runs with both pending
**Then** the tracker's read call precedes its first write call.

**TC-I-SYNC-04** — base snapshots are written only after the remote write succeeds
**Given** the tracker throws on `applyChanges` for one ticket
**Then** that ticket's base snapshot is unchanged
**And** other tickets still complete normally.

*Rationale: a base recorded for a write that never happened permanently desynchronises
that ticket — the tool would believe both sides agree when they do not.*

## Conflicts

**TC-I-SYNC-05** — a conflicted ticket is skipped, others proceed
**Given** three tickets, one conflicted
**Then** the two clean tickets sync
**And** the conflicted one is untouched
**And** the result reports one conflict.

**TC-I-SYNC-06** — an already-conflicted ticket is not re-evaluated
**Given** a ticket whose frontmatter has `sync.conflict: true`
**When** sync runs
**Then** no plan entries are produced for it, even if the remote has changed again.

*Rationale: repeatedly rewriting conflict markers around a human's in-progress edit
destroys their work.*

## Duplicate protection

**TC-I-SYNC-07** — a crashed creation is adopted, not duplicated
**Given** a local ticket `LOCAL-0007` with no Jira key
**And** the tracker already holds an issue labelled `sync-LOCAL-0007`
**When** sync runs with `apply: true`
**Then** `create` is **not** called
**And** the existing key is adopted into the local file.

*Simulates: Jira created the issue, then the process died before the key was written.*

**TC-I-SYNC-08** — creation attaches the sync label
**When** a new ticket is created
**Then** the draft passed to `create` includes label `sync-<localId>`.

## Cursors

**TC-I-SYNC-09** — the cursor advances only after all pages are written
**Given** a tracker returning two pages, throwing on the second
**Then** the stored cursor is unchanged from before the run.

**TC-I-SYNC-10** — the cursor is rewound by the skew window
**Given** a stored cursor of `T`
**When** the tracker is queried
**Then** the requested lower bound is `T - 5 minutes`.

**TC-I-SYNC-11** — re-processing an already-seen ticket is harmless
**Given** the skew window returns a ticket already merged in the previous run
**Then** the plan for it is empty.

*Rationale: the overlap exists to tolerate clock skew, so it must be idempotent or it
would generate spurious work on every run.*

## Scope flags

**TC-I-SYNC-12** — `--only jira` does not touch the external source
**Then** the issue-source port records zero calls.

**TC-I-SYNC-13** — `--limit N` caps tickets, not operations
**Given** twelve tickets needing changes and `limit: 10`
**Then** exactly ten tickets appear in the plan
**And** the result reports that two were withheld.

*Rationale: a silent cap reads as "everything is in sync" when it is not.*

## Deletion safety

**TC-I-SYNC-14** — a remote omitting a ticket never deletes it locally
**Given** a local ticket absent from the remote response
**Then** the ticket file remains and no delete or archive occurs.

*Rationale: absence from an incremental query means "not recently updated", not
"deleted". Conflating the two would erase the workspace.*
