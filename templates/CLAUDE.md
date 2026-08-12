# Working in this workspace

This directory is a ticket workspace managed by the `mgmt` CLI. Tickets are
Markdown files with YAML frontmatter; the tracker is the system of record for
some fields and the local files are authoritative for others.

## Rules

- **Never edit files under `.sync/`.** Those are merge bases and cursors. Editing
  one makes the next merge compute a difference that never happened.
- **Never hand-edit a field the tracker owns** (`status`, `assignee`, `type`,
  `parent`, `priority`, `due`). Change it in the tracker, then pull. Editing it
  locally produces a conflict, not an update.
- **Local files own** `title`, `body`, `labels` and `estimate`. Edit those here.
- `issues/` holds unprocessed items pulled from the external source. They are
  read-only copies. Promote one to a real ticket rather than editing in place.

## Commands

Every command that could write is a dry run unless given `--apply`.

```sh
mgmt status                 # what is pending, what conflicts
mgmt sync                   # show what would change
mgmt sync --apply           # do it
mgmt resolve <id> --take local | --take jira
mgmt promote issues/<file>
mgmt doctor                 # check credentials and instance settings
```

## When a sync reports a conflict

A conflict means the same field changed on both sides since the last sync. It is
not an error to retry past — retrying produces the same conflict. Read both
values, decide, then run `mgmt resolve`.

## Content marked local-only

Text inside a `local-only` block stays in this workspace and is stripped before
anything is pushed:

```
<!-- local-only -->
Internal notes, customer names, anything not for the shared tracker.
<!-- /local-only -->
```

If the stripping step cannot run, the push is refused rather than sent. Treat
that as intended behaviour, not a bug to work around.
