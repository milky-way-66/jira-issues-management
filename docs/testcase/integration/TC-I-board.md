# TC-I-BOARD — HTML rendering and identity resolution

Target: `adapters/board-html.ts`, `adapters/identity.ts` · Layer: integration ·
Dependencies: a temporary directory; the substitute tracker for the identity cases.

## Rendering

**TC-I-BOARD-01** — a ticket title cannot inject markup
**Given** a title of `<script>alert(1)</script>`
**Then** the output contains no live `<script>` opened by that title — the angle
brackets are escaped.

*Rationale: titles are written by other people in the tracker. The board is
opened from `file://`, where injected script runs with access to local files.*

**TC-I-BOARD-02** — a title containing quotes cannot escape an attribute
**Given** a title of `He said "no" & left`
**Then** both the visible text and the search index carry it escaped, and the
attribute is still well-formed.

**TC-I-BOARD-03** — the file fetches nothing
**Then** it contains no `<script src>`, `<link href>`, `<img>`, `<iframe>`, and no
`url(` in its styles.

*Rationale: the board sits in a workspace holding a customer's ticket titles. Any
subresource would announce every open of it to whoever serves that resource, and
a `file://` page can leak the local path in the referrer.*

**TC-I-BOARD-04** — a link to the tracker is still allowed
**Given** a ticket with a tracker URL
**Then** an anchor points at it — a link the reader clicks is not a fetch the page
performs, which is what TC-I-BOARD-03 forbids.

**TC-I-BOARD-05** — both boards are present in one file
**Then** it holds a project section and a personal section, each with its count,
and one is shown at a time.

**TC-I-BOARD-06** — a card links to its own ticket file
**Then** the anchor is the workspace-relative `tickets/<id>.md`, so the board
opened from the workspace root reaches the Markdown behind a card.

**TC-I-BOARD-07** — an empty personal board names who it is empty for
**Given** an identity of `alice` and nothing assigned
**Then** the message names `alice`, rather than implying the board is broken.

**TC-I-BOARD-08** — an unresolved identity explains how to fix it
**Then** the message names `MGMT_ME`.

## Identity

**TC-I-BOARD-09** — `MGMT_ME` wins over everything
**Given** a cache naming `bob` and `MGMT_ME=alice`
**Then** the resolved identity is `alice`, and the tracker is not asked.

**TC-I-BOARD-10** — a cached identity is used without asking the tracker
**Then** the substitute records no request.

**TC-I-BOARD-11** — the tracker is asked once, and the answer cached
**Given** no override and no cache
**Then** the tracker is asked, the name is returned, and `.sync/identity.json`
holds it **And** a second call makes no further request.

**TC-I-BOARD-12** — an unreachable tracker resolves to nobody rather than failing
**Given** the tracker errors
**Then** resolution returns null and does not throw.

**TC-I-BOARD-13** — a corrupt cache is treated as no cache
**Given** `.sync/identity.json` contains invalid JSON
**Then** the tracker is asked, and the file is rewritten.

**TC-I-BOARD-14** — with no override, no cache and no tracker, nobody is resolved
**Then** resolution returns null — the workspace may have no credentials at all.
