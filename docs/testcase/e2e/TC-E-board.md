# TC-E-BOARD — `mgmt board`

Target: the `board` command · Layer: e2e · Dependencies: a scaffolded workspace;
the substitute tracker where identity is involved.

**TC-E-BOARD-01** — the command writes `board.html` and exits 0
**Given** a workspace with tickets
**When** `mgmt board` runs
**Then** `board.html` exists at the workspace root and the exit code is 0.

*No `--apply`: the board is a view of the workspace and touches no ticket data,
so there is nothing a dry run would protect. Same rule as `mgmt index`.*

**TC-E-BOARD-02** — every ticket in the working set appears
**Then** each ticket key is present in the file, under its own status.

**TC-E-BOARD-03** — `--out` writes elsewhere
**When** `mgmt board --out docs/board.html` runs
**Then** the file is written there and the default path is left alone.

**TC-E-BOARD-04** — `--json` emits the model and writes no file
**Then** stdout parses as a board with `project`, `mine` and `columns`
**And** `board.html` was not created.

**TC-E-BOARD-05** — `--me` decides whose board the personal one is
**When** `mgmt board --me bob` runs
**Then** only tickets assigned to `bob` are in the personal view.

**TC-E-BOARD-06** — a workspace with no credentials still produces a board
**Given** no `JIRA_PAT`
**Then** the command exits 0, the project board is complete, and the output says
the personal one is empty because nobody could be identified.

*Rationale: the board is generated from local files. A missing token must cost
one view, not the command.*

**TC-E-BOARD-07** — an unreadable ticket is skipped, not fatal
**Given** one malformed file among several
**Then** the remaining tickets are rendered and the skipped id is reported.

**TC-E-BOARD-08** — `--columns` sets the column order
**When** `mgmt board --columns "Done,In Progress,To Do"` runs
**Then** the columns appear in that order.

**TC-E-BOARD-09** — a scaffolded workspace ignores the generated board
**Then** `.gitignore` covers `board.html` and `.sync/identity.json`.

*Rationale: the board is regenerated from the tickets, so committing it adds a
diff to every sync; the identity file names one person and must not be shared.*

**TC-E-BOARD-10** — the identity is resolved from the tracker once, then cached
**Given** a reachable substitute tracker and no `MGMT_ME`
**When** `mgmt board` runs twice
**Then** the personal board is the token owner's both times
**And** the tracker was asked exactly once.
