---
name: mgmt-report
description: Summarise the state of work — progress, who is working on what, what is overdue, what is blocked, what arrived this week. Use when the user asks for a status report, a standup summary, or an overview rather than a specific ticket.
---

# Reporting

Reports are read-only. Everything needed is already on disk; no command that
writes should run to produce one.

## Gather

```sh
mgmt status          # counts, conflicts, cursor positions
mgmt index           # regenerate INDEX.md if it looks stale
```

Then read `INDEX.md` for the overview and `tickets/*.md` for detail.

Use `mgmt status --json` when you need to reason about the numbers rather than
show them.

## Say when the data is stale

Check the cursors that `mgmt status` prints. If the last sync was days ago, the
report describes the workspace, not the tracker — **lead with that**. A confident
report built on a week-old pull is worse than no report, because nobody thinks to
question it.

Offer to run a sync first.

## Shapes worth producing

**Standup** — what changed since a date, grouped by person, with blockers first.

**Progress** — counts by status, plus what moved since the last report. Raw
counts alone tell nobody whether things are going well.

**Overdue** — tickets whose `due` has passed and whose status is not done. Say
how far overdue; "three days" and "three months" call for different responses.

**Unassigned / stale** — no assignee, or nothing changed in a long time. These
are the ones that quietly rot.

## Lead with what needs a decision

Order the report by what the reader must act on, not by ticket id:

1. Conflicts — sync is blocked on these.
2. Overdue and blocked work.
3. Everything else.

If `mgmt status` reports conflicts, they go first regardless of what was asked
for. Every other number in the report is provisional until they are settled.

## Honesty

- Do not infer an assignee, a due date, or a completion percentage that is not
  in the data.
- If tickets were unreadable, list them rather than quietly leaving them out.
- If a count is approximate because a sync is pending, say approximate.
