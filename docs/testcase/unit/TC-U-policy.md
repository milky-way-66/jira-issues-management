# TC-U-POLICY — field ownership and mapping rules

Target: `core/policy.ts` · Layer: unit · Dependencies: none

Specification: [sync-algorithm.md](../../sync-algorithm.md#field-ownership).

## Default owner on conflict

When `mgmt resolve` is called without `--take`, the default owner decides. One case per
field, both directions.

| Id | Field | Conflict resolved toward |
| --- | --- | --- |
| **TC-U-POLICY-01** | `status` | Jira |
| **TC-U-POLICY-02** | `assignee` | Jira |
| **TC-U-POLICY-03** | `type` | Jira |
| **TC-U-POLICY-04** | `parent` | Jira |
| **TC-U-POLICY-05** | `title` | neither — stays a conflict, requires an explicit choice |
| **TC-U-POLICY-06** | `body` | neither — stays a conflict |
| **TC-U-POLICY-07** | `labels` | neither — set-merged instead, so it should not reach here |

**TC-U-POLICY-08** — an explicit `--take` overrides the default
**Given** `status` conflicts and the default owner is Jira
**When** resolution requests `--take local`
**Then** the local value wins.

## Status transitions

**TC-U-POLICY-09** — a status change is expressed as a transition, not a field write
**Given** a plan pushing `status`
**Then** the emitted `FieldChange` is marked as requiring a transition
**And** it carries the target status *name*, never a numeric transition id.

*Rationale: transition ids are instance-specific. Resolving name → id belongs to the
adapter, which is what keeps Jira Cloud an adapter-only change.*

## Type changes

**TC-U-POLICY-10** — issue type is never changed automatically
**Given** local `type = Sub-task`, remote `type = Task`, base `Task`
**Then** the plan contains a **warning**, not a push
**And** no `FieldChange` for `type` is emitted.

*Rationale: changing issue type after creation frequently fails or silently drops
fields. A warning tells the user; an automatic attempt corrupts.*

## Vocabulary isolation

**TC-U-POLICY-11** — the core never emits provider-specific identifiers
**Given** any plan produced for any input
**Then** no field name matches `/^customfield_/`
**And** no key named `accountId` appears anywhere in the plan.

*Rationale: this is the executable form of the architectural rule. If it fails, provider
detail has leaked inward and the Jira Cloud swap will not be an adapter-only change.*

**TC-U-POLICY-12** — the parent relationship is expressed as `parent`
**Then** a hierarchy change appears as `FieldChange{ field: 'parent' }`, regardless of
how the tracker stores it.

## Promotion rules

**TC-U-POLICY-13** — a promoted external issue produces a draft with no key
**Given** an `ExternalIssue`
**When** the promotion rule runs
**Then** the resulting `TicketDraft` has `id` of the form `LOCAL-nnnn`, no `jira.key`,
and `github.repo` / `github.number` populated.

**TC-U-POLICY-14** — promotion carries the duplicate-protection label
**Then** the draft's labels include `sync-<localId>`.

**TC-U-POLICY-15** — the external issue title is preserved verbatim
**Given** a title containing non-Latin characters and bracketed prefixes
**Then** the draft title is byte-identical to the source.

*Rationale: translation or reformatting is a human decision made at triage, not
something the tool should do silently.*

**TC-U-POLICY-16** — local ids are allocated sequentially
**Given** the highest existing local id is `LOCAL-0007`
**When** two drafts are created in one run
**Then** they receive `LOCAL-0008` and `LOCAL-0009`, in that order.

*Rationale: no randomness — see the determinism requirements.*
