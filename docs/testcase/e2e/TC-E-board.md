# TC-E-BOARD — `mgmt board`

Target: the `board` command · Layer: e2e · Dependencies: a scaffolded workspace;
the substitute tracker where identity is involved.

**TC-E-BOARD-01** — the command serves the board on loopback
**Given** a workspace with tickets
**When** `mgmt board` runs
**Then** it prints a `127.0.0.1` URL that answers 200, and exits 0 when stopped.

*There is no file to open instead. A drag has to reach Jira and only this process
holds the token, so a page on disk could never act; one mode means what you see is
always something that can.*

**TC-E-BOARD-02** — every ticket in the working set appears
**Then** each ticket key is served, under its own status.

**TC-E-BOARD-03** — `--port` decides where it listens
**When** `mgmt board --port 8931` runs
**Then** the board is served on exactly that port.

**TC-E-BOARD-03b** — an edit made while it runs shows on the next load
**Given** a ticket written after the server started
**Then** reloading shows it, without restarting anything.

*Rationale: the board is a view of the files, and a stale view of files that are
being edited is the thing a generated snapshot got wrong.*

**TC-E-BOARD-04** — `--json` emits the model and serves nothing
**Then** stdout parses as a board with `project`, `mine` and `columns`, and the
command returns on its own rather than waiting to be stopped.

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

**TC-E-BOARD-09** — serving writes nothing into the workspace
**Then** the directory holds exactly what it held before
**And** `.gitignore` still covers `.sync/identity.json`, the one file a board may
add.

*Rationale: a board that leaves nothing behind cannot leave anything stale, and
the identity file names one person, so it must not be shared.*

**TC-E-BOARD-10** — the identity is resolved from the tracker once, then cached
**Given** a reachable substitute tracker and no `MGMT_ME`
**When** `mgmt board` runs twice
**Then** the personal board is the token owner's both times
**And** the tracker was asked exactly once.

## Moving a ticket

**TC-E-BOARD-11** — `mgmt move` is a dry run by default
**When** `mgmt move PROJ-1 Done` runs
**Then** it prints what it would do, and the tracker records no write.

**TC-E-BOARD-12** — `--apply` transitions the ticket and updates the file
**Then** the tracker reports the new status and the ticket file agrees.

*The base snapshot is part of the same write; TC-U-MOVE-09 and TC-U-MOVE-10 pin it
precisely, including that nothing but `status` is touched in it.*

**TC-E-BOARD-13** — a status the workflow does not offer is refused usefully
**When** a ticket is moved to a status with no transition to it
**Then** the command fails naming the statuses that *are* available.

**TC-E-BOARD-14** — `--apply` without a token fails before serving
**Then** the command exits non-zero saying no drag could reach the tracker, rather
than starting a server whose every drag would fail.

**TC-E-BOARD-15** — a drag moves a ticket, end to end
**Given** a board served with `--apply`
**When** the page's own nonce is used to post a move
**Then** the tracker transitions the ticket and the local file agrees.

*This is the whole path in one case: served page → nonce → use case → tracker →
file. The pieces are pinned separately in TC-I-SERVE and TC-U-MOVE.*
