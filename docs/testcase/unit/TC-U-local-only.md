# TC-U-LOCAL — the `local-only` filter

Target: `core/policy.ts` (local-only handling) · Layer: unit · Dependencies: none

**Treated as a security test.** A leak here sends internal notes to an external system,
which cannot be undone by a later fix.

Specification: [data-format.md](../../data-format.md#local-only-blocks).

## Stripping

**TC-U-LOCAL-01** — a local-only block is removed before push
**Given** a body containing one `<!-- local-only -->…<!-- /local-only -->` block
**When** the pushable description is computed
**Then** neither the block content nor the markers appear in the result.

**TC-U-LOCAL-02** — multiple blocks are all removed
**Given** three separate blocks in one body
**Then** none of their content appears in the result.

**TC-U-LOCAL-03** — surrounding content survives intact
**Given** text before, between and after the blocks
**Then** that text is preserved, with no stray blank-line accumulation.

## Malformed input — fail closed

**TC-U-LOCAL-04** — an unclosed block strips to end of document
**Given** `<!-- local-only -->` with no closing marker
**Then** everything from the marker to the end of the body is removed.

**TC-U-LOCAL-05** — a stray closing marker is inert
**Given** `<!-- /local-only -->` with no opening marker
**Then** the marker itself is removed and the surrounding content is preserved.

**TC-U-LOCAL-06** — nested markers strip the outermost span
**Given** a block containing another opening marker
**Then** the entire outer span is removed.

*Rationale for 04–06: every ambiguous case resolves toward removing more, never less.
Publishing an internal note is a worse outcome than losing a line of a public one, and
the local file always retains the original.*

## Round trip

**TC-U-LOCAL-07** — stripping never mutates the local file
**Given** a ticket with local-only content
**When** the pushable description is computed
**Then** the ticket in memory and on disk still contains the block unchanged.

**TC-U-LOCAL-08** — a pulled remote body never resurrects into the block
**Given** a local body with a local-only block, and a remote body pulled from Jira
**When** the pull is applied
**Then** the local-only block is still present, still in its original position.

*Rationale: this is the interaction most likely to be got wrong. A naive "overwrite body
from remote" silently deletes internal notes on the next sync.*

## Interaction with merge

**TC-U-LOCAL-09** — local-only edits alone do not trigger a push
**Given** the only local change is inside a local-only block
**When** `merge3` runs
**Then** the plan contains no push for `body`.

*Rationale: the pushable projection is unchanged, so there is nothing to send. Without
this, editing a private note would produce a pointless remote write on every sync.*

**TC-U-LOCAL-10** — comparison uses the stripped projection
**Given** base and remote bodies equal to the *stripped* local body
**Then** the plan is empty.

## Coverage requirement

`core/policy.ts` requires 100% branch coverage, and these cases are the reason. Any
uncovered branch in this filter is a potential disclosure path.
