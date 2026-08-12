# TC-I-SERVE — the board server

Target: `adapters/board-server.ts` · Layer: integration · Dependencies: a real socket
on loopback.

A board opened as a file cannot move a ticket: a `file://` page has no way to reach
Jira, and giving it one would mean writing a token into the workspace. So `mgmt board
--serve` keeps the token in the process and serves a page that talks to it.

Three properties hold, and each has a case here: loopback only, a nonce on every write,
and read-only unless `--apply`.

## Serving

**TC-I-SERVE-01** — `GET /` renders the current board
**Then** the response is HTML holding the tickets as they are on disk *now*, not as they
were when the server started.

**TC-I-SERVE-02** — the socket binds loopback only
**Then** the advertised URL is on `127.0.0.1`, so nothing off this machine can reach it
even on a hostile network.

**TC-I-SERVE-03** — the page declares a policy that forbids fetching anything
**Then** the response carries a `content-security-policy` with `default-src 'none'`, so
a stray absolute URL in a ticket title cannot quietly become a request.

**TC-I-SERVE-04** — an unknown path is a 404

**TC-I-SERVE-04b** — `HEAD /` answers like `GET` without a body
**Then** a probe sees the real headers rather than a 404 suggesting nothing is served.

## Writes

**TC-I-SERVE-05** — a move without the nonce is refused
**Then** 403, and the move is not attempted.

*Rationale: any program on this machine can reach a loopback port, and a page in another
tab can POST to one. Neither can read the served page to learn the nonce.*

**TC-I-SERVE-06** — a move with the wrong nonce is refused

**TC-I-SERVE-07** — a read-only server refuses every move
**Given** the server was started without `--apply`
**Then** 403, and the message names `mgmt board --serve --apply`.

*Rationale: serving is not consenting to writes — the same rule the rest of the CLI
follows.*

**TC-I-SERVE-08** — a valid move is performed and its result returned
**Then** the response carries where the ticket ended up.

**TC-I-SERVE-09** — the tracker's refusal reaches the browser intact
**Given** the move throws `no transition to "Done". Available: ...`
**Then** the response is 409 carrying that message, because it tells the reader exactly
what the workflow allows.

**TC-I-SERVE-10** — `/api/move` accepts POST only
**Then** anything else is 405.

**TC-I-SERVE-11** — a body that is not JSON is a 400

**TC-I-SERVE-12** — a body missing `id` or `to` is a 400

**TC-I-SERVE-13** — an oversized body is refused rather than buffered
**Then** 413, and the connection is dropped.

*Rationale: a drag is a few dozen bytes; anything larger is not a move.*

**TC-I-SERVE-14** — the nonce differs between runs
**Then** two servers started in the same session do not accept each other's nonce.
