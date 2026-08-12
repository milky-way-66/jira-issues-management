# Agent instructions

The instructions for this workspace live in [CLAUDE.md](./CLAUDE.md). Read that
file — this one exists only because different tools look for different filenames.

The three rules that matter most, repeated here so they are never missed:

1. Never call the tracker's API directly. Use the `mgmt` CLI; it is where the
   safeguards are.
2. Never edit anything under `.sync/`. Those are merge bases and cursors.
3. Never hand-edit a field the tracker owns (`status`, `assignee`, `type`,
   `parent`, `priority`, `due`). Change it in the tracker, then pull.
