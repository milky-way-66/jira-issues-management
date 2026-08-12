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

**Alpha — feature-complete against its specification, not yet used in anger.**

Every command in [`docs/cli.md`](docs/cli.md) is implemented, and all 153 specified
test cases have automated coverage (235 tests). `npm run trace` enforces that number:
a spec case with no test, or a test citing a case that does not exist, fails the build.

What that does *not* mean: it has not run against a production Jira for a sustained
period. Field mappings invented from a specification are exactly the kind of thing a
real instance disproves — see [`docs/local-jira.md`](docs/local-jira.md) for how to
check them against one before trusting it with real tickets.

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

Not published to npm. Install from the repository:

```sh
npm i -g git+ssh://git@github.com/milky-way-66/jira-issues-management.git#v0.1.0
```

Pin a tag. A scheduled job that upgrades itself overnight and breaks is the worst
failure mode available — `cli_range` in `config.yml` refuses a CLI outside the range
the workspace allows, and exits 3 rather than touching the data.

## Quick start

```sh
mgmt init                 # scaffold a workspace: config.yml, tickets/, agent rules
cp .env.example .env      # add JIRA_PAT
mgmt doctor               # verify token, server version, custom field ids
mgmt sync                 # show what would change — writes nothing
mgmt sync --apply         # do it
```

`mgmt doctor` tells you the Epic Link custom field id for your instance. Record it in
`config.yml`; guessing it means writing parent links into whatever field happens to
hold that number.

See [`docs/cli.md`](docs/cli.md) for the full command list.

## Working through an agent

`mgmt init` scaffolds both editors, since a team usually splits between them:

- **Claude Code** — `.claude/skills/` with a router (`mgmt`) and five narrower skills
  (triage, write, sync, resolve, report), plus a `settings.json` that denies direct API
  calls and edits to `.sync/`.
- **Cursor** — `.cursor/rules/mgmt.mdc`, always applied. Cursor has no skill mechanism,
  so the routing is inlined there.

Those two rules are enforced rather than merely stated, because the CLI is where every
safeguard lives: schema validation, dry-run, duplicate protection, `local-only`
stripping. An agent reaching past it discards all of them at once, and silently.

## Testing without a Jira instance

The suite runs against an in-process substitute that speaks the same REST subset over
loopback — no licence, no container, no network. The adapter additionally refuses any
non-loopback host while tests are running, with no opt-out.

For the mapping questions a substitute cannot answer, [`docs/local-jira.md`](docs/local-jira.md)
covers running a real instance in Docker. Point the opt-in suite at it:

```sh
MGMT_LIVE_JIRA_URL=http://localhost:8080 MGMT_LIVE_JIRA_PAT=... npm run test:live
```

Those checks assert *shapes*, never values this repository chose — a fixture invented
from a specification encodes the guess, not the fact. They are excluded from `npm test`
by configuration, not by remembering to skip them.

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
| [docs/local-jira.md](docs/local-jira.md) | Testing against a real Jira, locally |
| [docs/scheduling.md](docs/scheduling.md) | Running sync on a timer, and its off switch |
| [docs/testcase/](docs/testcase/) | Executable definition of correct behaviour |

## License

MIT
