# TC-I-JIRA — Jira adapter

Target: `adapters/jira.ts`, `adapters/jira-wiki.ts` · Layer: integration
Dependencies: hand-written JSON fixtures — **never** captured from a live instance

## Mapping

**TC-I-JIRA-01** — a REST v2 issue maps to `RemoteTicket`
**Given** a fixture issue with summary, description, status, assignee, labels, priority,
due date and time tracking
**Then** every field lands on the documented `RemoteTicket` property.

**TC-I-JIRA-02** — the Epic Link custom field maps to `parent`
**Given** `epic_link_field: customfield_10014` in configuration
**And** a fixture carrying that field
**Then** the result exposes `parent`, and no key beginning `customfield_` survives.

**TC-I-JIRA-03** — an unset assignee becomes null, not the string "null"
**TC-I-JIRA-04** — missing optional fields become absent, not empty string

**TC-I-JIRA-05** — unknown fields are ignored without error
**Given** a fixture containing fields the tool does not model
**Then** mapping succeeds.

*Rationale: Jira instances carry arbitrary custom fields. Strict rejection would make
the tool unusable on any real instance.*

## Writes

**TC-I-JIRA-06** — a status change issues a transition request
**Given** a `FieldChange` for `status`
**Then** the adapter resolves the transition id by name and POSTs to the transitions
endpoint
**And** does **not** include `status` in a field update payload.

**TC-I-JIRA-07** — an unavailable transition fails loudly
**Given** the requested status is not among the available transitions
**Then** the adapter throws an error naming both the requested status and the available
ones
**And** no partial update is sent.

**TC-I-JIRA-08** — labels are sent as add/remove operations
**Then** the payload uses the update-operations form, not a whole-array replacement.

*Rationale: replacing the array discards labels added by other people or automation
between two syncs.*

**TC-I-JIRA-09** — assignee uses `name`
**Then** the payload contains `name`, never `accountId`.

*`accountId` is Jira Cloud. Sending it to Server fails; sending `name` to Cloud fails.
This case pins which product this adapter targets.*

## Wiki markup conversion

**TC-I-JIRA-10** — Markdown converts to wiki markup
Headings, bold, italic, inline code, fenced code with language, bullet and numbered
lists, links, tables.

**TC-I-JIRA-11** — wiki markup converts back to Markdown
The same constructs, in reverse.

**TC-I-JIRA-12** — round trip is stable (property test)
**Given** every fixture body
**Then** `wiki → md → wiki` equals the original, ignoring trailing whitespace
**And** `md → wiki → md` equals the original, ignoring trailing whitespace.

*The single most valuable case in this file. Without it, every sync produces a phantom
diff, the tool rewrites unchanged tickets forever, and real changes drown in noise.*

**TC-I-JIRA-13** — non-Latin text survives conversion unchanged
**Given** bodies containing CJK characters and full-width punctuation
**Then** the round trip is byte-identical.

**TC-I-JIRA-14** — unconvertible constructs degrade, never throw
**Given** Markdown with a construct having no wiki equivalent
**Then** conversion produces a reasonable plain-text fallback and does not fail.

## Queries

**TC-I-JIRA-15** — the JQL includes project and updated bound, ordered ascending
**TC-I-JIRA-16** — paging follows `startAt` until exhausted
**TC-I-JIRA-17** — the sync-label lookup queries by label and returns at most one key

## Errors

**TC-I-JIRA-18** — 401 produces an authentication error naming the token variable
**TC-I-JIRA-19** — 429 is retried with backoff, then surfaces if still failing
**TC-I-JIRA-20** — a malformed response body fails with a message identifying the issue
key, not a bare parse error

## Fixture policy

Fixtures are **written by hand** using placeholder values — `PROJ`,
`jira.example.com`, `alice`, `bob`. Never paste a real API response into this
repository: it is public, and live responses carry customer content.
