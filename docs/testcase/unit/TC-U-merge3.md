# TC-U-MERGE — three-way merge

Target: `core/merge3.ts` · Layer: unit · Dependencies: none

`merge3(base, local, remote) → SyncPlan` is pure. No mocks, no async, no clock.

Specification: [sync-algorithm.md](../../sync-algorithm.md#decision-table-per-field).

## The decision table

One case per row. These five are the core of the entire tool.

| Id | base | local | remote | Expected plan |
| --- | --- | --- | --- | --- |
| **TC-U-MERGE-01** | `To Do` | `To Do` | `To Do` | empty — no pull, no push, no conflict |
| **TC-U-MERGE-02** | `To Do` | `To Do` | `In Progress` | one `pull` of `status` |
| **TC-U-MERGE-03** | `To Do` | `In Progress` | `To Do` | one `push` of `status` |
| **TC-U-MERGE-04** | `To Do` | `Done` | `Done` | no pull, no push; BASE update only |
| **TC-U-MERGE-05** | `To Do` | `In Progress` | `In Review` | one conflict on `status`; no pull, no push |

## Field independence

**TC-U-MERGE-06** — fields are decided independently
**Given** `status` changed only on the remote, and `assignee` changed only locally
**Then** the plan contains one pull (`status`) *and* one push (`assignee`)
**And** neither is reported as a conflict.

**TC-U-MERGE-07** — a conflict on one field does not suppress other fields
**Given** `status` conflicts, `title` changed only locally
**Then** the plan contains a conflict for `status` **and** a push for `title`.

*Rationale: a per-ticket abort would let one stuck field freeze everything else on that
ticket indefinitely.*

## Missing base

**TC-U-MERGE-08** — no base, local and remote identical
**Given** `base = null`, local and remote have equal values for every field
**Then** the plan is empty; a base snapshot is recorded.

**TC-U-MERGE-09** — no base, values differ
**Given** `base = null`, `local.status = 'To Do'`, `remote.status = 'Done'`
**Then** `status` is reported as a **conflict** — never an automatic pull or push.

*Rationale: with no base there is no evidence about which side moved. Guessing here is
exactly how edits get destroyed.*

## Set-valued fields

**TC-U-MERGE-10** — labels merge as a set, not a wholesale overwrite
**Given** base `[a, b]`, local `[a, b, c]` (added `c`), remote `[a]` (removed `b`)
**Then** the resulting label set is `[a, c]`
**And** the plan expresses it as add/remove operations, not a replacement array.

**TC-U-MERGE-11** — identical label additions on both sides converge
**Given** base `[a]`, local `[a, b]`, remote `[a, b]`
**Then** no conflict; BASE update only.

## Absent and empty values

**TC-U-MERGE-12** — clearing a field locally is a real change
**Given** base `assignee = 'alice'`, local `assignee = null`, remote `assignee = 'alice'`
**Then** one `push` setting `assignee` to null.

**TC-U-MERGE-13** — absent is distinguished from empty string
**Given** base `due = null`, local `due = ''`, remote `due = null`
**Then** the plan is empty — `''` and `null` must normalise to the same absent value.

*Rationale: YAML round-trips can turn one into the other; without normalisation the tool
would push a phantom change on every run forever.*

## Body text

**TC-U-MERGE-14** — whitespace-only differences are not changes
**Given** local and base bodies differ only in trailing whitespace and final newline
**Then** the plan is empty.

*Rationale: the Markdown ↔ wiki round trip is not byte-exact. Without this rule the tool
generates an infinite stream of phantom diffs and the noise makes real changes
invisible.*

**TC-U-MERGE-15** — a real body edit on both sides conflicts
**Given** base, local and remote bodies all differ in substance
**Then** one conflict on `body`, and the plan carries both texts for presentation.

## Plan shape

**TC-U-MERGE-16** — the plan is serialisable
**Then** `JSON.parse(JSON.stringify(plan))` deep-equals `plan`.

*Rationale: the same object is printed for a human, emitted by `--json`, and handed to
an agent. A class instance with behaviour would not survive that.*

**TC-U-MERGE-17** — merge performs no I/O
**Then** the function completes with no filesystem, network or clock access.

*In practice this is guaranteed structurally by the dependency rule; the case documents
the requirement so it is not lost in a refactor.*
