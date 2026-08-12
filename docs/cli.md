# CLI

```sh
mgmt sync                  # pull external + pull tracker + push tracker — DRY RUN
mgmt sync --apply          # actually perform it
mgmt sync --only jira      # restrict to one side
mgmt sync --limit 10       # cap the number of tickets touched (blast-radius control)
mgmt sync --scheduled      # no-op unless sync.scheduled is on — for cron

mgmt pull github [--full]  # --full reconciles deleted/transferred issues

mgmt promote issues/<file> [--type Task] [--parent PROJ-100] [--force]
mgmt new "title" [--type Sub-task] [--parent PROJ-123]     # creates LOCAL-nnnn

mgmt resolve <id> --take local | --take jira | --done

mgmt index                 # regenerate INDEX.md
mgmt board                 # generate board.html — two Kanban views
mgmt board --me bob --columns "To Do,In Progress,Done"
mgmt board --serve         # serve it on loopback, read-only
mgmt board --serve --apply # ...and let a drag move a ticket

mgmt move PROJ-1 "In Progress"           # DRY RUN
mgmt move PROJ-1 "In Progress" --apply   # transition it
mgmt status                # pending pushes, conflicts, cursor positions
mgmt doctor                # tokens, server version, custom field ids, permissions

mgmt init                  # scaffold a workspace
mgmt upgrade               # refresh agent templates to match the installed CLI
mgmt migrate               # raise the workspace schema_version
mgmt --version
```

## Dry-run is the default

Every command that could write requires `--apply`. This is the primary safeguard: a bug
in field mapping or merge logic damages real tickets in a shared system, and those
edits are not easily undone.

`mgmt sync` prints the plan it would execute. `mgmt sync --apply` executes *that same
plan object* — the preview and the action cannot diverge.

## Promotion is one-way and once

`mgmt promote` copies a mirrored external issue into a ticket you own. It never edits
the mirror: those files are overwritten wholesale on the next pull, so an edit there
would be lost, and the local copy of someone else's issue would stop matching theirs.

Promoting the same issue twice is refused, naming the ticket that already points at it.
The mirror file stays in `issues/` afterwards looking unpromoted, which makes the second
attempt an easy mistake — and its cost is two tracker issues for one external issue,
deleted by hand in a shared project. `--force` is there for the case where a second
ticket is deliberate: split work, or a follow-up.

## The board

`mgmt board` writes a Kanban view of the workspace to `board.html`: **Project tasks**
(everything) and **My tasks** (assigned to you), sharing one set of columns so the two
line up when you switch between them. Open it from the workspace root — each card links
to its own `tickets/<id>.md` and, once pushed, to the tracker.

It reads the ticket files and nothing else, so it works on a plane and can never show
something the files do not say. Like `mgmt index`, it needs no `--apply`: it generates a
view and touches no ticket data.

The file is self-contained — no stylesheet, script, font or image is fetched from
anywhere. That is deliberate: the board holds a customer's ticket titles, and a
subresource would announce every open of it to whoever serves that resource.

### Columns

Column *names* come from the tracker — they are the statuses in your ticket files. Their
*order* does not, because a ticket records the status it is in and nothing about the
workflow it belongs to. Recognised names (`To Do`, `In Progress`, `In Review`, `Done`
and their usual synonyms) are ordered by how far along they are; anything unrecognised
is placed between the active states and the done ones, in first-seen order.

That last part is a guess. When it is wrong, say so explicitly:

```sh
mgmt board --columns "Chờ làm,Đang làm,Chờ duyệt,Xong"
```

Listed statuses come first, in that order, and are drawn even when empty — an empty
`Done` column is the shape of the workflow, not noise.

### Who "my tasks" belongs to

In order: `MGMT_ME` from the environment or `.env`; then `.sync/identity.json`; then the
tracker, asked once via `/myself` and cached. So the first run with a working token needs
no setup, and every run after it is offline.

A username in the tracker often differs from the local one, which is why it is asked
rather than assumed. `--me <user>` overrides for one run — useful for looking at a
colleague's board.

If nobody can be resolved — no token, no cache, no override — the command still succeeds
and the project board is complete. Not knowing who you are costs one view, not the board.

Both `board.html` and `.sync/identity.json` are gitignored: the board is regenerated from
the tickets, and the identity file names one person.

### Dragging a card

A board written to a file cannot move anything. A `file://` page has no way to reach
Jira, and the only way to give it one would be to write your token into a file in the
workspace — not a trade worth making for a drag gesture. So the token stays in the
process and the page talks to it instead:

```sh
mgmt board --serve --apply
```

Dragging a card to another column transitions the ticket in Jira, then updates the local
file and the merge base, so the next `mgmt sync` has nothing to reconcile. The card moves
on screen only *after* the tracker confirms — and it lands in the column the tracker
reports, which a workflow post-function can make different from where you dropped it.

Three rules hold while serving:

- **Loopback only.** The socket binds `127.0.0.1`; nothing off the machine can reach it.
- **A nonce on every write**, embedded in the served page. Any program on this machine
  can reach a loopback port and any tab can POST to one, but neither can read the page to
  learn the nonce.
- **Read-only without `--apply`.** Serving is not consenting to writes.

If the workflow has no transition to where you dropped it, Jira's own refusal is shown —
including which transitions *are* available.

`mgmt move <id> <status>` does the same thing from the terminal, and like everything else
that writes, it is a dry run until `--apply`.

## Workspace discovery

The CLI is installed globally, so it has to find the data. In order:

1. `--workspace <path>`
2. `MGMT_WORKSPACE` environment variable
3. walking up from the current directory until a `config.yml` containing a `mgmt:` key
   is found — the same way git locates `.git`
4. otherwise: fail with a message pointing at `mgmt init`

Step 3 means the command works from any subdirectory of the workspace.

## Output

Human-readable tables by default. `--json` emits the `SyncPlan` / result as JSON for
scripts, CI, and coding agents. Both come from the same object.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success; nothing needed doing, or `--apply` completed cleanly |
| 1 | unexpected error (network, auth, malformed data) |
| 2 | conflicts present — sync completed for other tickets, these need a human |
| 3 | version incompatibility between CLI and workspace `schema_version` |

A disabled scheduled run exits 0, not 1. It is a decision, not a failure, and a
nonzero code would page someone every interval. See [scheduling.md](scheduling.md).

Code 2 matters for automation: a scheduled run should surface conflicts as an alert
without treating the whole run as a failure.

## Safety rules

- Nothing is ever deleted. Closed tickets move to `archive/`.
- A remote returning fewer tickets than expected never causes local deletion.
- Version compatibility is checked before every command, including read-only ones, and
  cannot be bypassed with a flag.
- Scheduled runs should pin an exact CLI version. A cron job that upgrades itself
  overnight and breaks is the worst failure mode available.
