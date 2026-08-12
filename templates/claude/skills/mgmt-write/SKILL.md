---
name: mgmt-write
description: Draft or edit ticket content — titles, descriptions, acceptance criteria, estimates, labels. Use when the user wants to write, rewrite, flesh out or correct what a ticket says.
---

# Writing ticket content

## What you may edit

The local file owns these, and you can edit them directly:

| Field | Where |
| --- | --- |
| `title` | frontmatter |
| `labels` | frontmatter |
| `estimate` | frontmatter |
| body | everything after the frontmatter |

## What you must not edit

`status`, `assignee`, `type`, `parent`, `priority`, `due` belong to the tracker.
Changing one locally does not update the tracker — it produces a conflict on the
next sync, which someone then has to resolve by hand.

If the user asks to change one of these, say so and offer the two real options:
change it in the tracker and then pull, or (for status) let the sync do it, which
goes through the workflow properly.

Also never touch the `sync:` block, and never touch `.sync/`.

## Creating a ticket from nothing

```sh
mgmt new "Title goes here" --type Task --parent PROJ-100 --apply
```

Then edit the body. It reaches the tracker on the next sync.

## Body conventions

Write Markdown. The tool converts to and from the tracker's own markup at the
boundary, and the conversion is stable — but it is only stable for constructs it
knows. Prefer headings, lists, fenced code blocks, links and emphasis. Elaborate
tables and raw HTML survive as literal text, which usually is not what anyone
wants.

Structure worth defaulting to:

```markdown
## Context

Why this exists. One paragraph.

## Acceptance criteria

- [ ] Something specific and checkable
- [ ] Another

## Notes

Anything that helps whoever picks this up.
```

## Content that must not leave the workspace

Wrap anything internal — a customer name, a credential path, a candid assessment
— in a local-only block:

```markdown
<!-- local-only -->
Not for the shared tracker.
<!-- /local-only -->
```

It is stripped before the body is pushed. If the stripping step cannot run, the
push is refused rather than sent. That is intended: failing closed on this is the
whole point.

Use it when in doubt. Removing something from a shared tracker after the fact
does not remove it from the notifications it already generated.

## Before you finish

Show the user the diff, then let the sync carry it:

```sh
mgmt sync            # confirm the plan
mgmt sync --apply
```
