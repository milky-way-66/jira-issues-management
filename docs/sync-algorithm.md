# Sync algorithm

This is the part that can destroy real data. It is specified before it is written, and
tested exhaustively as a pure function.

## Three versions of every ticket

```
BASE    = .sync/base/PROJ-123.json   the remote state at the last successful sync
LOCAL   = tickets/PROJ-123.md        what is on disk now
REMOTE  = Jira API                   what is on the server now
```

`merge3(base, local, remote)` is a **pure function** returning a `SyncPlan`. It performs
no I/O, calls no clock, and is therefore testable with a truth table and zero mocks.

## Decision table, per field

Applied independently to each field (`title`, `status`, `assignee`, `body`, …):

| LOCAL vs BASE | REMOTE vs BASE | Action |
| --- | --- | --- |
| same | same | nothing |
| same | **changed** | pull: remote → local |
| **changed** | same | push: local → remote |
| **changed** | **changed**, values equal | converged — update BASE only |
| **changed** | **changed**, values differ | ⚠️ **conflict** |

After a plan executes successfully, BASE is overwritten with the new REMOTE.

### Missing base

If `.sync/base/<id>.json` is absent (a ticket seen for the first time, or a workspace
restored without it), the tool **must not** guess. Treat every differing field as a
conflict and let a human decide. Silently choosing a side is how data disappears.

## Conflicts

The tool never picks a winner. It:

1. Sets `sync.conflict: true` in the frontmatter.
2. Writes a git-style block into the body:

```markdown
<<<<<<< LOCAL
status: In Progress
=======
status: In Review        # jira, changed by bob at 2026-08-11T09:00+09:00
>>>>>>> JIRA
```

3. Skips that ticket on every later sync — including scheduled runs — until a human
   runs `mgmt resolve <id> --take local|jira`, or edits by hand and runs
   `mgmt resolve <id> --done`.

A conflicted ticket **does not block other tickets**. Sync continues; the run reports
conflicts at the end and exits non-zero.

## Field ownership

The three-way merge resolves most cases on its own. This table is the **default when a
conflict is resolved without an explicit `--take`**, and the convention users should
expect.

| Local field | Jira (REST v2) | Default owner | Notes |
| --- | --- | --- | --- |
| `title` | `fields.summary` | both | |
| body `## Description` | `fields.description` | both | via the wiki-markup converter |
| `status` | `fields.status.name` | **Jira** | pushed through `POST /transitions`, never a direct field write |
| `assignee` | `fields.assignee.name` | **Jira** | Jira Server uses `name`; `accountId` is Cloud-only |
| `type` | `fields.issuetype.name` | Jira | changing type after creation often fails — warn, never auto-change |
| `parent` | Epic Link / `fields.parent` | Jira | Epic Link is a custom field id, discovered once by `mgmt doctor` |
| `labels` | `fields.labels` | both | merged as a set (add/remove diff), never overwritten wholesale |
| `estimate` | `timetracking.originalEstimate` | both | |
| `priority`, `due` | `priority.name`, `duedate` | both | |
| `local-only` block | — | local | **never pushed** |
| comments, worklog | — | Jira | mirrored read-only |

The external issue's `state` (open/closed) is reference information on a promoted
ticket. It does **not** drive Jira status.

## Incremental pull

Full scans do not scale and burn rate limit.

- **Jira** — JQL `project = PROJ AND updated >= "<cursor - 5m>" ORDER BY updated ASC`,
  paged with `startAt`. The five-minute overlap absorbs server clock skew.
- **GitHub** — `GET /repos/{owner}/{repo}/issues?state=all&since=<cursor>&sort=updated`
  with `If-None-Match`; a 304 costs no quota.

Cursors live in `.sync/state.json` and advance **only after every page is written**. A
crash mid-run therefore resumes from the old cursor, which is safe because every
operation is idempotent.

⚠️ GitHub's `since` filters on `updated_at`, so **deleted or transferred issues never
appear**. `mgmt pull github --full` reconciles; run it weekly.

## Duplicate protection

Creating a Jira issue is not idempotent, and a crash between "Jira created it" and
"local recorded the key" would otherwise create a second one on the next run.

Before creating, the tool queries `project = PROJ AND labels = "sync-<localId>"`. If a
match exists it **adopts that key** instead of creating. The label `sync-LOCAL-0007` is
attached at creation time for exactly this purpose.

## Execution order

```
1. pull external issues   → issues/            (read-only, safe)
2. pull tracker           → merge into tickets/
3. push tracker           → create + update
4. write base snapshots + advance cursors
5. report
```

Pulling before pushing means a plan is always computed against the freshest remote
state, which narrows the window in which a conflict can be missed.
