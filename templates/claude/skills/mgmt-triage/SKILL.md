---
name: mgmt-triage
description: Handle incoming issues from the external source — reviewing what arrived, summarising it, and promoting an issue into a real ticket. Use when the user asks about customer issues, new reports, the issues/ folder, or wants to turn an issue into a task.
---

# Triaging incoming issues

`issues/` mirrors an external source that this tool **never writes to**. The
files there are read-only copies, overwritten on every pull. Editing one is
pointless; the edit disappears on the next pull.

## See what arrived

```sh
mgmt pull github            # preview
mgmt pull github --apply    # write the mirror
```

Then read the files. Summarise them for the user: who reported it, what state it
is in, what it appears to be about. If the issues are in a language the user does
not read, translate the summary — but **never translate the title in the ticket
you create**. See below.

## Promote one into a ticket

```sh
mgmt promote issues/<file> --type Task --parent PROJ-100     # preview
mgmt promote issues/<file> --type Task --parent PROJ-100 --apply
```

Before running it, propose:

- **Type** — `Task`, `Bug`, `Sub-task` as the project uses them.
- **Parent** — the epic or parent key, if there is an obvious one. Ask rather
  than inventing one.
- **Title** — the tool copies the source title verbatim, on purpose. If the
  project has a naming convention, propose the adjusted title *to the user* and
  let them accept it; do not rewrite it silently. A title that no longer matches
  what the customer wrote makes the two systems impossible to reconcile by hand.

Promotion creates a `LOCAL-nnnn` ticket. It reaches the tracker on the next
sync:

```sh
mgmt sync            # confirm
mgmt sync --apply
```

The created ticket carries a `sync-LOCAL-nnnn` label. That label is what lets an
interrupted creation be recovered instead of duplicated — do not remove it, and
do not create the issue in the tracker by hand.

## What not to do

- Do not write to the external source. Not a comment, not a label, not a close.
  The tool has no code path for it, and neither should you.
- Do not promote the same issue twice. Check `tickets/` for an existing ticket
  referencing that issue number first.
- Do not edit files under `issues/`.
