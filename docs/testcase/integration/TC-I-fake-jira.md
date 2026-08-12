# TC-I-FAKE — local Jira substitute

Target: `test/support/fake-jira.ts` · Layer: integration
Dependencies: none — an in-process HTTP server bound to loopback

The tool must be developable and demonstrable without a Jira instance, without a
credential, and without a network. A real tracker is unavailable in CI, its
contents cannot be committed to a public repository, and a test pointed at a live
instance would write to someone's real project.

So the adapter runs against a substitute that speaks the same wire protocol over
a real socket. This exercises the parts injected fixtures cannot: URL building,
header handling, status codes, response bodies, paging arithmetic.

The substitute is only trustworthy if it is itself tested. These cases pin the
behaviours the sync algorithm depends on. Where the substitute and real Jira
disagree, the substitute is wrong and this file is where the correction lands.

## Protocol fidelity

**TC-I-FAKE-01** — the adapter reaches the substitute over a real socket
**Given** the substitute started on a loopback port
**When** the adapter fetches one issue with the platform `fetch`, not an injected one
**Then** the issue maps to a `RemoteTicket`.

*Rationale: everything else in this file is meaningless if the adapter is still
talking to a stub.*

**TC-I-FAKE-02** — a wrong token is rejected with 401
**Then** the adapter raises the authentication error naming the token variable.

**TC-I-FAKE-03** — an absent issue answers 404 and the adapter returns null

**TC-I-FAKE-04** — `updated` advances on every write
**Given** an issue is edited twice
**Then** the second timestamp is strictly later than the first.

*Rationale: a substitute with a frozen clock would let broken cursor logic pass.
Every real sync depends on this ordering.*

## Search

**TC-I-FAKE-05** — search pages through `startAt` until exhausted
**Given** more issues than one page holds
**Then** iterating yields each issue exactly once, in `updated` order.

**TC-I-FAKE-06** — the `updated` bound filters the result set
**Given** a cursor later than some issues' timestamps
**Then** only issues at or after the bound are returned.

**TC-I-FAKE-07** — the sync-label lookup finds an issue by label

## Writes

**TC-I-FAKE-08** — status moves only through a declared transition
**Given** a transition set that offers no route to the requested status
**Then** the adapter raises, and the stored status is unchanged.

*Rationale: real workflows forbid arbitrary jumps. A substitute that accepted any
status would hide the single most likely push failure.*

**TC-I-FAKE-09** — a direct write to the status field is refused
**Then** the substitute answers 400, as Jira does.

**TC-I-FAKE-10** — label add and remove operations apply without disturbing others
**Given** an issue carrying labels set outside the tool
**When** one label is added and another removed
**Then** the untouched labels remain.

**TC-I-FAKE-11** — a created issue is retrievable by its returned key

## Safety

**TC-I-FAKE-12** — a pull run issues no write request
**Given** a completed pull
**Then** every request the substitute received used a read method.

*Rationale: this is the assertion that makes an accidental write visible. It is
the reason the substitute records requests at all.*
