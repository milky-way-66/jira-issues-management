# Documentation

Read in this order:

1. **[architecture.md](architecture.md)** — the hexagon, the one dependency rule, and
   what lives in `core/` vs `adapters/`.
2. **[data-format.md](data-format.md)** — ticket files, frontmatter schema,
   `config.yml`, and the `.sync/` state directory.
3. **[sync-algorithm.md](sync-algorithm.md)** — three-way merge, conflict handling,
   incremental cursors. The heart of the tool.
4. **[cli.md](cli.md)** — commands, flags, exit codes.
5. **[testcase/](testcase/)** — the test specification. Every rule stated in the
   documents above appears there as a numbered, checkable case.

## How this project is built

Documentation first, then test cases, then code:

```
docs  ──▶  test cases  ──▶  code  ──▶  run tests  ──▶  feedback  ──▶  fix code
  ▲                                                                     │
  └──────── if the docs turn out to be wrong, fix the docs first ────────┘
```

Automated tests are the primary source of feedback. Manual verification is reserved
for the final check before running against a real Jira instance.

A consequence for the code: **lean interfaces, loose coupling, every component
testable in isolation.** That is the entire reason for the ports-and-adapters shape
described in [architecture.md](architecture.md) — the ports are the seams where a test
substitutes an in-memory implementation, so no mocking framework is ever needed.

## Writing rules for this repository

This repository is **public and generic**. It must never contain:

- real hostnames, company names, or project keys — use `jira.example.com`, `PROJ`
- real repository names — use `acme/app`
- real usernames — use `alice`, `bob`
- fixtures copied from a live system — write them by hand
- tokens or credentials of any kind

Project-specific values belong in the user's own `config.yml` and `.env`, never here.
CI enforces this with a scan; see [architecture.md](architecture.md#public-repository).
