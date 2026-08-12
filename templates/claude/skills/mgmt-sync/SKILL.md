---
name: mgmt-sync
description: Run and explain a synchronisation between the local ticket workspace and the tracker. Use when the user asks to sync, push, pull, or update the tracker, or asks what a sync would change.
---

# Synchronising

## The two-step rule

Never run `--apply` first. Always:

```sh
mgmt sync            # 1. plan
# show the plan, get agreement
mgmt sync --apply    # 2. execute that same plan
```

The preview and the execution share one plan object, so what you show is what
runs. Skipping step 1 discards the only chance to catch a wrong field mapping
before it reaches a shared tracker, where the edit is not easily undone.

## Narrowing the blast radius

```sh
mgmt sync --only jira      # ignore the external issue source
mgmt sync --limit 10       # touch at most ten tickets
```

Use `--limit` when the plan is large or surprising. If the output says tickets
were withheld, **say so** — a capped run is not a completed run, and reporting it
as "synced" is how a partial state gets mistaken for a finished one.

## Reading a plan

```
PROJ-123
  pull  status: To Do → In Progress
  push  body: Old text... → New text...
  ! type is never changed automatically: Task → Sub-task
```

- `pull` — the tracker's value wins and lands locally.
- `push` — the local value is sent to the tracker.
- `!` — the tool noticed a difference it will not act on unattended. Report it;
  the user changes it in the tracker themselves.
- `CONFLICT` — both sides changed the same field. Hand off to `mgmt-resolve`.

Translate the plan into plain language. "Three tickets move to In Progress, one
description is updated, one has a conflicting title" is more useful than the raw
listing.

## After applying

Report what actually happened, including failures. If any ticket failed:

- The workspace is still consistent — the tool writes a ticket's merge base only
  after that ticket's remote write succeeded.
- Recovery is to run it again. Never suggest hand-repairing files.

## Pulling from the external source

```sh
mgmt pull github            # preview
mgmt pull github --apply    # mirror into issues/
mgmt pull github --full     # full scan, for reconciling deletions
```

Files under `issues/` are read-only copies, overwritten on every pull. They are
not tickets. To act on one, hand off to `mgmt-triage`.

## What not to do

- Do not run `--apply` because the plan "looked fine". Get agreement.
- Do not retry a conflict; retrying produces the identical conflict.
- Do not edit `.sync/` to "fix" a cursor.
