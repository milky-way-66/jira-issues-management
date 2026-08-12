# Architecture

## The hexagon — two rings, one rule

```
        CLI  ──calls──▶ ┌─────────────────────────────┐
                        │            CORE             │
   (later: MCP) ──────▶ │  merge3() · Ticket · policy │
                        │  use cases: sync, promote…  │
                        │  ──── declares PORTS ────   │
                        └──────┬──────┬──────┬────────┘
                               │      │      │
                          TrackerPort │   TicketRepoPort
                               │  IssueSourcePort │
                               ▼      ▼      ▼
                            Jira   GitHub  Markdown + fs
                          (adapter)(adapter)  (adapter)
```

**The only rule: `core/` must not import from `adapters/`.** That is the whole
architecture. No sub-layers, no presenters, no DTO ceremony.

Enforced in CI, not by memory:

```jsonc
// .dependency-cruiser.json
{ "forbidden": [{
    "name": "core-must-not-know-adapters",
    "from": { "path": "^src/core" },
    "to":   { "path": "^src/adapters" },
    "severity": "error" }]}
```

**`core/` holds** entities (`Ticket`), the algorithm (`merge3`), business rules (field
ownership, the `local-only` filter, promotion rules), and the use cases that
orchestrate them. No `fs`, no `http`, no `Date.now()`.

**`adapters/` holds** everything that knows about Jira REST, Octokit, YAML
frontmatter, file paths, and the CLI.

## What this buys

| Scenario | Work required |
| --- | --- |
| Jira Server → Jira Cloud | add `jira-cloud.ts` (v3 + ADF + `accountId`), change one line in `main.ts` |
| A different external tracker (Redmine, Backlog…) | new adapter for `IssueSourcePort` |
| An agent calling use cases directly instead of shelling out to the CLI | add an MCP adapter beside the CLI adapter |
| Tests without network or tokens | in-memory adapter |

None of these touch `core/`. That is the point.

## Ports

All ports live in a single file, `src/core/ports.ts` — there are few enough that
reading them together is easier than hunting through a directory.

```ts
export interface TrackerPort {            // Jira sits behind this
  fetchUpdatedSince(cursor: Instant): AsyncIterable<RemoteTicket>
  create(draft: TicketDraft): Promise<TicketId>
  applyChanges(id: TicketId, changes: FieldChange[]): Promise<void>
  findBySyncLabel(localId: string): Promise<TicketId | null>   // duplicate guard
}

export interface IssueSourcePort {        // GitHub sits behind this — READ-ONLY by design
  fetchUpdatedSince(cursor: Instant): AsyncIterable<ExternalIssue>
  fetchAll(): AsyncIterable<ExternalIssue>            // weekly reconcile
}

export interface TicketRepoPort {         // Markdown + fs sit behind this
  list(): Promise<TicketId[]>
  load(id: TicketId): Promise<Ticket | null>
  save(t: Ticket): Promise<void>
  archive(id: TicketId): Promise<void>                // never deletes
  readBase(id: TicketId): Promise<RemoteTicket | null>
  writeBase(id: TicketId, snap: RemoteTicket): Promise<void>
  getCursor(key: string): Promise<Instant | null>
  setCursor(key: string, value: Instant): Promise<void>
}

export interface ClockPort { now(): Instant }         // so tests can pin time
```

`IssueSourcePort` deliberately has **no write methods**. "We never write to the
external tracker" is expressed in the type system, not in a code review comment.

Base snapshots and cursors share `TicketRepoPort` because both are "this workspace's
state on disk". Splitting them into three ports would add files without adding any
real ability to substitute one.

### Ports speak business language, not REST

The trap that makes a hexagon pointless is letting a port become a 1:1 mirror of the
Jira REST API (`updateIssueFields(jsonPayload)`) — swap the provider and the core
breaks anyway. Concretely:

- Raw objects from Octokit or Jira REST **stop at the adapter**. The adapter maps them
  to `RemoteTicket`. The core never touches `fields.customfield_10014`.
- **Markdown ↔ wiki markup conversion lives in the Jira adapter.** The core only knows
  a canonical Markdown string — which is exactly why Jira Cloud (ADF) would be an
  adapter-only change.
- `transition` vs `PUT field` is a Jira Server detail the adapter handles. The core
  says `FieldChange{ field: 'status', to: 'In Review' }`.

## Use cases are functions

Not classes. Dependencies arrive as a parameter:

```ts
// src/core/use-cases/sync-tickets.ts
export async function syncTickets(
  deps: { tracker: TrackerPort; repo: TicketRepoPort; clock: ClockPort },
  opts: { apply: boolean; only?: 'jira' | 'github'; limit?: number },
): Promise<SyncPlan> { … }
```

The use case list is the command list: `syncTickets`, `pullExternalIssues`,
`promoteIssue`, `resolveConflict`, `buildIndex`, `diagnose`.

**Dry-run is not a flag threaded through the code.** `syncTickets` always computes a
`SyncPlan` — a plain data structure. `--apply` only decides whether `executePlan(plan)`
runs. So the plan shown to a user and the work actually performed are the same object
and cannot drift apart.

## Directory layout

```
src/
├── core/                     ◀── imports nothing from adapters/
│   ├── ticket.ts             Ticket, TicketId, RemoteTicket, TicketDraft
│   ├── merge3.ts             ★ merge(base, local, remote) → SyncPlan
│   ├── policy.ts             field ownership · local-only · promotion rules
│   ├── ports.ts              every interface
│   └── use-cases/
│       ├── sync-tickets.ts
│       ├── pull-external-issues.ts
│       ├── promote-issue.ts
│       ├── resolve-conflict.ts
│       ├── build-index.ts
│       └── diagnose.ts
│
├── adapters/
│   ├── jira.ts               TrackerPort — REST v2
│   ├── jira-wiki.ts          Markdown ↔ wiki markup — ONLY here
│   ├── github.ts             IssueSourcePort — Octokit
│   ├── markdown-repo.ts      TicketRepoPort — frontmatter + zod + fs
│   ├── cli.ts                argument parsing, output formatting
│   └── in-memory.ts          ★ test double for every port
│
└── main.ts                   composition root — the ONLY place real adapters are built
```

**Only `main.ts` constructs real adapters.** Everywhere else receives them as
arguments. This is what makes the Jira Cloud swap genuinely a one-line change, and what
lets the whole test suite run with no token and no network.

## Determinism requirements

These are constraints on the code, not tricks for the tests:

- **No `Date.now()` in core** — use `ClockPort`. This is the only reason that port
  exists.
- **No randomness.** Local ids (`LOCAL-0007`) are allocated sequentially from stored
  state, not generated as UUIDs.
- **Stable ordering.** Frontmatter keys are written in a fixed order and file lists are
  sorted before iteration, or snapshot tests fail at random.

## Public repository

This repository is public and must stay generic. CI fails the build if project-specific
identifiers appear:

```jsonc
"scripts": {
  "scan":  "! grep -rniE '<forbidden-identifiers>' src templates docs README.md",
  "check": "dependency-cruiser src && npm test && npm run scan"
}
```

This is not only a confidentiality measure — it is the test of whether the architecture
holds. If a customer hostname or project key ever *has* to be hard-coded into the tool,
then project-specific logic has leaked into the core and the design has failed.
