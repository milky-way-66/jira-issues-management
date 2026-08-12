---
name: tickets
description: Read, search, sync and resolve tickets in this workspace via the mgmt CLI. Use whenever the user asks about ticket status, wants to sync with the tracker, resolve a conflict, promote an incoming issue, or create a ticket.
---

# Ticket workspace router

You are operating on a ticket workspace. Translate what the user asks for into
`mgmt` commands. Do not read or write ticket files directly when a command
exists — the command maintains the merge bases that the next sync depends on.

## Route

| The user wants | Run |
| --- | --- |
| an overview, "what's pending" | `mgmt status` |
| to see what a sync would do | `mgmt sync` |
| to actually sync | `mgmt sync --apply` |
| only one side | `mgmt sync --only jira --apply` |
| to pull incoming issues | `mgmt pull github` |
| to turn an incoming issue into a ticket | `mgmt promote issues/<file> --type Task` |
| a new ticket | `mgmt new "<title>" --type Task` |
| to settle a conflict | `mgmt resolve <id> --take local` or `--take jira` |
| to check credentials or instance settings | `mgmt doctor` |

Add `--json` when you need to reason about the result rather than show it.

## Before running anything that writes

Run the command without `--apply` first and show the user the plan. `--apply`
executes that same plan, so the preview is accurate rather than indicative.

Do not add `--apply` on the user's behalf unless they asked to perform the
change. "What would sync do?" is not permission to sync.

## Interpreting the result

- **Exit 0** — done, or nothing needed doing.
- **Exit 2** — conflicts. The rest of the sync succeeded. List the conflicted
  tickets and what differs on each side, then ask which side wins. Do not guess.
- **Exit 3** — the CLI and the workspace disagree on schema version. Tell the
  user which versions are involved. Do not attempt to work around it.
- **Exit 1** — something failed. Show the error. If it mentions `JIRA_PAT`, the
  token is missing or expired; say so without printing any value.

## What not to do

- Never edit `.sync/`.
- Never edit `status`, `assignee`, `type`, `parent`, `priority` or `due` in a
  ticket file. Those belong to the tracker; change them there and pull.
- Never write to the external issue source. The tool cannot, and neither should
  you — it is someone else's repository.
- Never paste a token into a file, a command line, or a message.
