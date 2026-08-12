# TC-I-REPO — Markdown repository

Target: `adapters/markdown-repo.ts` · Layer: integration
Dependencies: a temporary directory

## Round trip

**TC-I-REPO-01** — save then load reproduces the ticket exactly
**Given** a ticket using every documented field
**Then** the loaded ticket deep-equals the original.

**TC-I-REPO-02** — save is byte-stable
**Given** a ticket loaded from disk and saved again with no modification
**Then** the file bytes are unchanged.

*Rationale: without this, a sync that changes nothing still produces a git diff, and
scheduled runs generate endless empty commits.*

**TC-I-REPO-03** — frontmatter key order is fixed
**Given** two tickets whose fields were assigned in different orders
**Then** the serialised key order is identical.

## Formatting fidelity

**TC-I-REPO-04** — non-Latin text is written unescaped and reads back identical
**TC-I-REPO-05** — a title containing a colon, brackets or quotes round-trips
**TC-I-REPO-06** — a body containing `---` is not mistaken for a frontmatter delimiter
**TC-I-REPO-07** — a body containing conflict markers round-trips unchanged

*04–07 are the character classes most likely to break a naive YAML writer, and each maps
to content this tool routinely handles.*

## Validation

**TC-I-REPO-08** — a missing required field is rejected with the file path and field
name
**TC-I-REPO-09** — an unknown status value loads successfully

*Rationale: workflows are configurable per instance; the tool must not impose a fixed
status vocabulary.*

**TC-I-REPO-10** — a malformed file fails without affecting other tickets
**Given** one unparseable file among several
**When** the workspace is listed and loaded
**Then** the others load, and the failure is reported with its path.

## Listing

**TC-I-REPO-11** — listing is sorted deterministically
**TC-I-REPO-12** — non-ticket files in the directory are ignored
**TC-I-REPO-13** — `archive/` is excluded from ordinary listing

## Base snapshots and cursors

**TC-I-REPO-14** — a base snapshot round-trips
**TC-I-REPO-15** — a missing base snapshot returns null rather than throwing
**TC-I-REPO-16** — cursors persist across repository instances
**TC-I-REPO-17** — base snapshot writes are atomic

**Given** a write interrupted midway
**Then** the previous snapshot remains intact and readable.

*Rationale: a truncated base snapshot is worse than none — it may parse yet describe a
state that never existed, corrupting the next merge. Write to a temporary file and
rename.*

## Archive

**TC-I-REPO-18** — archiving moves the file and never deletes content
**TC-I-REPO-19** — archiving preserves the base snapshot alongside it

## Local ids

**TC-I-REPO-20** — the next local id follows the highest existing one, including
archived tickets

*Rationale: reusing an archived id would make the duplicate-protection label point at
the wrong Jira issue.*
