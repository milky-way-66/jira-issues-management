# TC-U-BOARD — Kanban projection of the workspace

Target: `core/use-cases/board.ts` · Layer: unit · Dependencies: none

The board is built from the ticket files alone. Every value on a card was already
pulled from the tracker by a sync, so these cases are about *arrangement* —
grouping, ordering and filtering — never about fetching.

## Columns

**TC-U-BOARD-01** — one column per distinct status
**Given** tickets in `To Do`, `In Progress` and `To Do`
**Then** two columns exist, holding two cards and one.

**TC-U-BOARD-02** — recognised statuses run from earliest to latest
**Given** tickets in `Done`, `To Do`, `In Progress` in that file order
**Then** the columns are `To Do`, `In Progress`, `Done`.

*Rationale: a ticket records the status it is in and nothing about the workflow it
belongs to, so the order cannot be read off the files. Ranking the names we
recognise avoids a network call for a command that otherwise needs none.*

**TC-U-BOARD-03** — an unrecognised status lands between active and done
**Given** statuses `To Do`, `Chờ duyệt` and `Done`
**Then** `Chờ duyệt` is placed after `To Do` and before `Done`, rather than last.

**TC-U-BOARD-04** — two unrecognised statuses keep first-seen order
**Then** the column order is stable across runs on unchanged data.

**TC-U-BOARD-05** — an explicit order wins, and comes first
**Given** `order: ['Done', 'To Do']`
**Then** the first two columns are `Done` then `To Do`, whatever their rank
**And** any status not listed is appended by rank.

**TC-U-BOARD-06** — an explicitly named column is rendered even with no cards
**Given** `order: ['To Do', 'Done']` and no ticket is `Done`
**Then** a `Done` column exists and is empty.

*Rationale: an empty Done column is the shape of the workflow; silently dropping
it makes the board look like work cannot finish.*

**TC-U-BOARD-07** — a status matches its column ignoring case and surrounding space
**Given** `order: ['to do']` and a ticket whose status is `To Do`
**Then** the ticket lands in that column rather than creating a second one.

## Cards

**TC-U-BOARD-08** — cards within a column are ordered by ticket number
**Given** `PROJ-12`, `PROJ-2`, `PROJ-100`
**Then** they appear as `PROJ-2`, `PROJ-12`, `PROJ-100`, not lexicographically.

**TC-U-BOARD-09** — a card carries the tracker URL when the ticket has been pushed
**And** carries null for a ticket that exists only locally.

**TC-U-BOARD-09b** — a ticket with a key but no recorded URL still gets a link
**Given** a ticket whose `jira.url` is empty — every ticket pulled before the
tracker URL was recorded looks like this
**Then** the card carries a link built from its key.

*Rationale: the alternative is rewriting every file in every workspace to add a
value that can be derived. A card that silently fails to link is the worse bug.*

**TC-U-BOARD-09c** — a ticket with no key gets no link
**Then** the card's URL is null, whatever builder was supplied.

**TC-U-BOARD-10** — a conflicted ticket is marked on its card
**Given** a ticket whose sync state records a conflict
**Then** the card is flagged, so the board shows what `mgmt status` would.

## My tasks

**TC-U-BOARD-11** — the personal view holds only tickets assigned to that user

**TC-U-BOARD-12** — assignee matching ignores case
**Given** `me = 'Alice'` and an assignee of `alice`
**Then** the card is included.

*Rationale: a tracker's casing of a username is not stable, and a board that
silently shows nothing is indistinguishable from having no work.*

**TC-U-BOARD-13** — an unassigned ticket is never mine
**Given** `me = null` on the ticket and any `me`
**Then** it appears on the project board only.

**TC-U-BOARD-14** — an unresolved identity yields an empty personal view
**Given** `me = null`
**Then** `mine` is empty **And** the project view is unaffected.

*Rationale: not knowing who you are costs you one view, not the board.*

## Both views

**TC-U-BOARD-15** — both views share one column list, in one order
**Then** the personal board's columns equal the project board's, so the two line
up when switched between.

**TC-U-BOARD-16** — an empty workspace produces a board with no columns
**Then** both totals are zero and nothing throws.
