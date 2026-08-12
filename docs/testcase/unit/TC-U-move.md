# TC-U-MOVE — moving a ticket to another status

Target: `core/use-cases/move.ts` · Layer: unit · Dependencies: in-memory ports

Status is a tracker-owned field, so a move is a push: the transition happens in the
tracker first, and the local file follows. This is the write behind a drag on the board,
and behind `mgmt move`.

## Refusals

**TC-U-MOVE-01** — an unknown ticket is refused
**Then** it fails naming the id, and nothing is sent to the tracker.

**TC-U-MOVE-02** — moving to the status it already has does nothing
**Given** a ticket in `In Progress` moved to `in progress`
**Then** the result reports no change **And** no transition is attempted.

*Rationale: a drag that lands where it started is the commonest gesture on a board.*

**TC-U-MOVE-03** — a conflicted ticket is refused
**Then** the message points at `mgmt resolve`, and no transition is attempted.

*Rationale: the same reason `plan()` skips a conflicted ticket — a transition would
settle one field of a disagreement someone is in the middle of resolving.*

**TC-U-MOVE-04** — a ticket that does not exist in the tracker is refused
**Given** a `LOCAL-nnnn` ticket never synced
**Then** the message points at `mgmt sync --apply`.

## Dry run

**TC-U-MOVE-05** — without `--apply`, nothing is written anywhere
**Then** the result describes the move, the tracker records no call, and the file is
unchanged.

## Applying

**TC-U-MOVE-06** — the change is sent as a transition, not a field write
**Then** the tracker receives a `status` change marked as requiring a transition,
carrying the target status name.

**TC-U-MOVE-07** — the local file records the new status

**TC-U-MOVE-08** — the ticket lands where the tracker says it landed
**Given** a workflow whose post-function moves the ticket to `In Review` when `Done` was
requested
**Then** the file, and the reported result, say `In Review`
**And** the result still reports what was requested, so the difference can be shown.

*Rationale: the board's whole claim is that it never shows something the tracker does
not say. Assuming the drop target succeeded would break exactly that.*

**TC-U-MOVE-09** — the base snapshot records the new status
**Then** the next `mgmt sync` sees no status difference to reconcile.

**TC-U-MOVE-10** — the base snapshot keeps every other field it had
**Given** a base whose title differs from what is now in the tracker
**Then** only `status` is rewritten in it.

*Rationale: writing the whole remote ticket into the base would be easier and wrong —
it would swallow every other change made in the tracker since the last sync, and no
later sync would ever pull them.*

**TC-U-MOVE-11** — a ticket with no base snapshot is still moved
**Then** the transition happens and the file is updated; no base is invented.

**TC-U-MOVE-12** — the push is stamped on the ticket

**TC-U-MOVE-13** — a tracker failure leaves the local file alone
**Given** the tracker rejects the transition
**Then** the error propagates and the file still shows the old status.

*Rationale: a file claiming a status the tracker refused is worse than a failed move.*
