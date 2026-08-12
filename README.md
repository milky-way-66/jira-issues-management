# jira-issues-management

Manage Jira tickets and external GitHub issues as **plain Markdown files in a git
repository**, with a safe two-way sync back to Jira.

```
GitHub Issues  ──pull──▶  issues/  ──promote──▶  tickets/  ◀──sync──▶  Jira
   (external)    one-way    staging   (a human)   local canon  two-way
   READ-ONLY
```

Your tickets become files you can grep, diff, review in a pull request, and hand to a
coding agent. Jira stays the system of record for your team; the files stay the place
you actually work.

## Status

**Pre-alpha — design and test specification only.** No code yet. The documents in
[`docs/`](docs/) define the behaviour; the test cases in
[`docs/testcase/`](docs/testcase/) define what "correct" means. Implementation follows
them, not the other way around.

## Why files

- **Reviewable** — a ticket change is a diff, not an audit-log entry.
- **Offline-first** — read and edit without a network round trip.
- **Agent-friendly** — Claude Code, Cursor and friends already read Markdown well.
- **Recoverable** — git history is the backup; nothing is ever deleted, only archived.

## Design principles

1. **Dry-run by default.** Every command prints a plan; only `--apply` writes.
2. **Never guess on conflict.** If both sides changed the same field, stop and ask.
3. **The external issue tracker is read-only.** This tool never writes to it.
4. **The tool is generic; the project lives in config.** No customer, hostname or
   project key is hard-coded anywhere in this repository.

## Install

Not published yet. Once tagged:

```sh
npm i -g git+ssh://git@github.com/milky-way-66/jira-issues-management.git#v0.1.0
```

## Quick start (planned)

```sh
mgmt init                 # scaffold a workspace: config.yml, .claude/
mgmt doctor               # verify tokens, server version, custom field ids
mgmt sync                 # show what would change — writes nothing
mgmt sync --apply         # do it
```

See [`docs/cli.md`](docs/cli.md) for the full command list.

## Compatibility

- **Jira Server / Data Center** via REST API v2 (wiki-markup descriptions).
  Jira Cloud is not supported yet — see [`docs/architecture.md`](docs/architecture.md)
  for how it would be added.
- **GitHub Issues**, read-only.
- Node.js ≥ 20.

## Documentation

| Document | What it answers |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | How the code is organised and why |
| [docs/data-format.md](docs/data-format.md) | What a ticket file looks like |
| [docs/sync-algorithm.md](docs/sync-algorithm.md) | How two-way sync decides what to do |
| [docs/cli.md](docs/cli.md) | Commands and flags |
| [docs/testcase/](docs/testcase/) | Executable definition of correct behaviour |

## License

MIT
