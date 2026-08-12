# Checking the mapping against a real Jira

The test suite proves the logic is correct. It cannot prove the *mapping* is —
that a real instance returns `timetracking.originalEstimate` rather than
`timeoriginalestimate`, or which custom field id holds Epic Link on your server.
Those are facts about a running Jira. Inventing a fixture for them encodes the
guess, not the fact.

So there is exactly one question this document answers: **before trusting the
tool with real tickets, how do you check the mapping once, by hand?**

## The rule this does not break

`npm test` contacts nothing but loopback. No licence, no container, no account,
no network — clone and run. Both adapters refuse a non-loopback host while tests
are running, and TC-E-SAFE-01d asserts that refusal is armed in the process doing
the asserting.

Everything below is a **deliberate manual check**, run by a person who decided to
run it. It is not part of `npm test` and must not become part of it: a suite that
depends on an external service being reachable, licensed and awake fails for
reasons unrelated to the code, and then stops being run.

## What you need

A Jira Server or Data Center instance you are willing to write to, reachable on
loopback, holding a project you can throw away.

How you get one is your business — a port-forward to a staging instance, a
container, a colleague's dev box. This repository deliberately ships no way of
starting one: every route to a real Jira needs a licence issued by Atlassian, so
automating it here would only disguise an external dependency as a local one.

The loopback guard still applies, which is what keeps this from ever pointing at
production.

## Point the tool at it

```yaml
# config.yml
jira:
  base_url: "http://localhost:8080"
  project: "PROJ"
  epic_link_field: null      # doctor will tell you the real id
```

```sh
export JIRA_PAT=...          # Profile → Personal Access Tokens, on the instance
mgmt doctor                  # confirms version, deployment type, epic link field
mgmt sync                    # dry run — prints the plan, writes nothing
```

`mgmt doctor` reporting `Server 9.x` and a `customfield_*` id is the signal that
the wiring is right. Record that id in `config.yml`; guessing it means writing
parent links into whatever field happens to hold that number.

## Replay the automated cases against it

Two suites are written to run against either tracker, behind their own config so
that no stray environment variable can pull a plain `npm test` onto a real
instance — live mode is a property of which config was used, never of what is in
your shell:

```sh
MGMT_LIVE_JIRA_URL=http://localhost:8080 \
MGMT_LIVE_JIRA_PAT=... \
MGMT_LIVE_JIRA_PROJECT=PROJ \
npm run test:live
```

- `test/live/live-jira.test.ts` — read-only. Asserts *shapes*: deployment type,
  the Epic Link field id, that no required field is lost, that real descriptions
  survive the round trip. It asserts no value this repository chose.
- `test/e2e/intake-flow.test.ts` (TC-E-INTAKE) — the full external-issue path:
  mirror, promote, sync. **It creates issues**, so point it at a throwaway
  project. The external source is always the local mock, never a real repository.

A case that passes against the substitute and fails here is the mapping being
wrong. That is the entire reason for running the same assertions twice.

## What to check by eye

Compare a pulled ticket file against the same issue in the browser:

- Run `mgmt sync` twice. The second run must plan nothing — if it does not, the
  body round trip is not a fixed point and the tool will rewrite that ticket
  forever.
- Do non-Latin characters, code blocks, links and numbered lists come back
  intact?
- Does the estimate land, in the unit the browser shows?
- Is the assignee the account name, not a display name?

Anything that disagrees is a fixture that lied. Fix the adapter, then correct the
case in `docs/testcase/` so the substitute stops lying too.

## What never to do

- Do not point `npm test` at a real instance. It assumes a tracker it fully
  controls and does not clean up after itself. `npm run test:live` is the one
  written for an instance you share.
- Do not reuse a production personal access token here.
- Do not expose the instance beyond loopback while you are doing this.
