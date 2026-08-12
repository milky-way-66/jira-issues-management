# TC-I-GH — GitHub adapter (read-only)

Target: `adapters/github.ts` · Layer: integration
Dependencies: hand-written fixtures

## Read-only guarantee

**TC-I-GH-01** — the adapter exposes no write capability
**Then** `IssueSourcePort` has no create, update, comment or close method
**And** the adapter implements nothing beyond it.

*Enforced by the type system rather than by discipline. This is a design guarantee about
someone else's repository, so it should be impossible rather than merely discouraged.*

**TC-I-GH-02** — only GET requests are issued
**Given** a request recorder wrapping the HTTP client
**When** every adapter method runs
**Then** every recorded request uses GET.

## Mapping

**TC-I-GH-03** — an issue maps to `ExternalIssue`
Number, title, body, state, labels, author, created and updated timestamps.

**TC-I-GH-04** — pull requests are excluded
**Given** a fixture list containing an entry with a `pull_request` key
**Then** it does not appear in the results.

*The REST issues endpoint returns pull requests too. Without this filter, every PR
becomes a fake ticket.*

**TC-I-GH-05** — the repository identity travels with the issue
**Then** each result carries owner and repo, so multiple repositories can share one
workspace without number collisions.

**TC-I-GH-06** — non-Latin titles and bodies are preserved verbatim

## Incremental fetch

**TC-I-GH-07** — `since` and `state=all` are both sent
**Then** closed issues updated after the cursor are included.

*Rationale: closing an issue is exactly the kind of update the tool must observe.*

**TC-I-GH-08** — a stored ETag is sent as `If-None-Match`
**TC-I-GH-09** — a 304 response yields no items and does not disturb the cursor
**TC-I-GH-10** — pagination follows the `Link` header until exhausted

**TC-I-GH-11** — `fetchAll` ignores the cursor
**Then** the request carries no `since` parameter.

*This is the weekly reconcile path — its whole purpose is to observe what the
incremental query structurally cannot.*

## Rate limits

**TC-I-GH-12** — a rate-limit response is retried after the reset time
**Given** 403 with `X-RateLimit-Remaining: 0` and a reset timestamp
**Then** the adapter waits until reset (using the injected clock) and retries once
**And** surfaces a clear error if still limited.

*The clock is injected, so this test does not actually sleep.*

## Errors

**TC-I-GH-13** — 404 reports the repository name and likely cause (missing or no access)
**TC-I-GH-14** — 401 reports which token variable to check
