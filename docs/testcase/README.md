# Test specification

These documents are written **before the code**. They are the definition of correct
behaviour; the implementation is whatever makes them pass.

## Layers

| Layer | Scope | Dependencies | Budget |
| --- | --- | --- | --- |
| **Unit** | `core/merge3.ts`, `core/policy.ts` | none — pure functions | whole layer < 1s |
| **Integration** | use cases + in-memory adapters; real adapters + hand-written fixtures | no network, no real fs | < 10s |
| **E2E** | the real `mgmt` binary, a temp workspace, a fake HTTP server | real fs, real git, HTTP on loopback | < 60s |

The unit layer is where the investment goes. `merge3` is where a bug destroys real
data, and it is also the cheapest thing to test — a pure function with no mocks.

## Identifier scheme

```
TC-U-<area>-<nn>    unit
TC-I-<area>-<nn>    integration
TC-E-<area>-<nn>    end-to-end
```

Ids are permanent. When a case is retired, mark it obsolete rather than reusing the
number, so historical discussion stays readable.

## Case format

Every case states Given / When / Then in terms an implementer can turn into a test
without inventing behaviour:

> **TC-U-MERGE-03** — remote changed, local unchanged
> **Given** base.status = `To Do`, local.status = `To Do`, remote.status = `In Progress`
> **When** `merge3` runs
> **Then** the plan contains exactly one `pull` for `status`, no `push`, no conflict

If writing a case reveals that the documentation is ambiguous, **fix the documentation
first**. That is the cheapest possible moment to discover a design flaw.

## Traceability

| Documented rule | Cases |
| --- | --- |
| Decision table, [sync-algorithm.md](../sync-algorithm.md#decision-table-per-field) | [TC-U-MERGE](unit/TC-U-merge3.md) |
| Field ownership table | [TC-U-POLICY](unit/TC-U-policy.md) |
| `local-only` never pushed | [TC-U-LOCAL](unit/TC-U-local-only.md) |
| External tracker is read-only | [TC-I-GH](integration/TC-I-github-adapter.md), [TC-E-SAFE](e2e/TC-E-safety.md) |
| Duplicate protection | [TC-I-SYNC-07](integration/TC-I-sync-usecase.md) |
| Dry-run writes nothing | [TC-I-SYNC-01](integration/TC-I-sync-usecase.md), [TC-E-FLOW-03](e2e/TC-E-sync-flow.md) |
| Version compatibility | [TC-E-SAFE-04](e2e/TC-E-safety.md) |
| Incremental cursors | [TC-I-SYNC-08](integration/TC-I-sync-usecase.md) |
| Conflict handling | [TC-U-MERGE-05](unit/TC-U-merge3.md), [TC-E-FLOW-05](e2e/TC-E-sync-flow.md) |

## Determinism

Tests must not be flaky, and that is achieved by constraining the code rather than by
retrying:

- time is injected through `ClockPort` — tests pin it to a fixed instant
- no randomness — local ids are sequential
- frontmatter key order is fixed and file lists are sorted before iteration
- tests run with `TZ=Asia/Tokyo` so timezone handling is exercised, not accidental

## Coverage policy

100% branch coverage is required for `core/merge3.ts` and `core/policy.ts` only. No
threshold is set elsewhere — a global percentage target produces tests written to raise
a number rather than to catch a defect.

## The one thing tests cannot cover

Whether a created ticket *renders correctly* in a real Jira UI — wiki markup, Epic Link,
non-Latin characters. Verify that by hand, once, against a throwaway project, before
the tool is ever pointed at a real one.
