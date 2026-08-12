---
name: mgmt
description: Use for ANY request about tickets, tasks, issues, the tracker, sprints or the backlog in this workspace — viewing, creating, editing, assigning, syncing, triaging incoming customer issues, reporting progress, resolving conflicts. Trigger this even when the user only mentions a ticket key (PROJ-123, LOCAL-0007) or asks something vague like "what's left to do".
---

# Ticket router

This is the single entry point for ticket work. Five narrower skills sit behind
it. They exist because description-matching between skills whose descriptions
all mention "ticket", "task" and "sync" picks the wrong one often enough to
matter — so the choice is made here, by an explicit table, rather than guessed
by the runtime.

## Step 1 — always run this first

```sh
mgmt status
```

It costs nothing and it tells you three things you need before doing anything
else: how many tickets there are, which are conflicted, and where the cursors
sit.

**If conflicts > 0, say so before doing anything else.** Sync is blocked on those
tickets, so any plan that ignores them is wrong. Then continue with the request.

## Step 2 — route

| The user wants | Go to |
| --- | --- |
| to see, ask about, or find a ticket | read `INDEX.md`, then `tickets/<id>.md`. Do **not** delegate |
| to create or edit content, acceptance criteria, a description | `mgmt-write` |
| anything about incoming customer issues, triage, promotion | `mgmt-triage` |
| to synchronise — "push to the tracker", "pull", "sync" | `mgmt-sync` |
| to deal with a conflict | `mgmt-resolve` |
| a report — progress, who is working on what, what is overdue | `mgmt-report` |

Reading a ticket is the most common request by a wide margin, and it needs no
tooling beyond the filesystem. Delegating it just adds a hop.

## Hard rules

These are enforced in `.claude/settings.json` as well as stated here, because a
rule that lives only in a prompt is a suggestion.

1. **Never call the tracker's API directly.** No `curl`, no SDK, no scripts. The
   CLI is where every safeguard lives — schema validation, dry-run, duplicate
   protection, `local-only` stripping. Going around it discards all of them at
   once, silently.
2. **Never edit `.sync/`.** Those are merge bases and cursors. A hand-edited
   base makes the next merge compute a difference that never happened.
3. **Never edit the `sync:` block** in a ticket's frontmatter. The tool owns it.

You *may* freely read any Markdown file, run `mgmt` with any arguments, and edit
the body and locally-owned fields of `tickets/*.md`.

## Before anything that writes

Every command that could write is a dry run unless given `--apply`. Run it
without `--apply`, show the user the plan, and wait. `--apply` executes that same
plan, so the preview is accurate rather than indicative.

"What would happen if we synced?" is not permission to sync.

## Reading exit codes

- **0** — done, or nothing needed doing.
- **2** — conflicts. The rest succeeded. Hand these to `mgmt-resolve`.
- **3** — the CLI and the workspace disagree on schema version. Report it; do not
  work around it.
- **1** — failure. Show the message. If it names `JIRA_PAT`, the token is missing
  or expired — say that without printing any value.
