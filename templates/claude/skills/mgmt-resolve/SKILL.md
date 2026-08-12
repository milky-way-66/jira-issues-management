---
name: mgmt-resolve
description: Walk through resolving a sync conflict on a ticket. Use when a sync reports conflicts, when a ticket has sync.conflict true, or when the user asks what to do about a conflicting ticket.
---

# Resolving a conflict

A conflict means **the same field changed on both sides** since the last sync.
It is not an error and not something to retry past — retrying recomputes the
identical conflict. It needs a decision.

## Step 1 — show both sides

```sh
mgmt resolve <id> --take local     # preview only; nothing is written
```

The preview prints, per conflicted field, the local value, the tracker value,
and which one would win. Show that to the user in plain language.

Do not summarise away the difference. "The titles differ" is useless; the user
needs to see both titles to choose.

## Step 2 — get an explicit decision

Ask which side wins. **Never guess.** The tool deliberately refuses to, and so
should you: the two values usually encode two people's intentions, and picking
one silently discards someone's work without telling them.

If the values are not actually in conflict — say, the same change phrased
differently — the user may want to edit the file by hand and then declare it
settled. That is `--done`.

## Step 3 — record it

```sh
mgmt resolve <id> --take local --apply    # keep the local value, push it
mgmt resolve <id> --take jira  --apply    # keep the tracker's value
mgmt resolve <id> --done --apply          # the file was hand-edited; it stands
```

Only the conflicted fields move. Fields that merged cleanly are left alone —
taking a side is not the same as overwriting the whole ticket.

Resolving also records the tracker's current state as the new merge base. That
is what makes the decision stick; without it the next sync would raise the same
conflict again.

## Step 4 — finish the sync

Taking the local side leaves a push outstanding:

```sh
mgmt sync            # confirm the plan
mgmt sync --apply
```

Taking the tracker's side needs no push — that value is already there.

## Why conflicts happen

Most often: someone edited a field the tracker owns (`status`, `assignee`,
`type`, `parent`, `priority`, `due`) in the local file instead of in the tracker.

Worth mentioning once, gently, when it is the cause — it stops the same conflict
recurring weekly. The local file owns `title`, `body`, `labels` and `estimate`.
