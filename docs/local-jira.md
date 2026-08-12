# Testing against a real Jira, locally

There are two ways to run this tool without touching a production tracker. They
answer different questions, and using the wrong one wastes a lot of time.

| | Substitute (`test/support/fake-jira.ts`) | Docker instance |
| --- | --- | --- |
| Answers | "is the logic correct?" | "does the mapping match reality?" |
| Setup | none | licence, 2 GB RAM, ~10 min |
| Speed | milliseconds | minutes |
| Part of `npm test` | yes | **never** |
| Use it | constantly | once per phase, by hand |

The container needs an evaluation licence, which needs an Atlassian account and a
request to my.atlassian.com. That is what keeps it out of the test loop: tests
must not depend on an external service being reachable, licensed, or awake.

## The substitute

This is the default and covers almost everything. It is an in-process HTTP
server bound to loopback that speaks the same REST v2 subset the adapter calls.

```sh
npm test
```

It models the two behaviours that matter for correctness: `updated` advances on
every write, and status moves only through a declared transition. A substitute
without those would let broken cursor logic and impossible status jumps pass.

The adapter additionally refuses any non-loopback host while tests are running,
so a misconfigured URL cannot reach a live instance. That check has no opt-out.

## The Docker instance

The substitute cannot tell you that a real Jira returns `timetracking.originalEstimate`
rather than `timeoriginalestimate`, or which custom field id holds Epic Link on
*this* instance. Those are facts about a real server, and inventing a fixture for
them just encodes the guess. Verify them once against a real instance per phase —
the roadmap calls this out for P1 specifically.

### Start it

```sh
docker compose -f docker-compose.jira.yml up -d
docker compose -f docker-compose.jira.yml logs -f jira   # wait for the startup banner
```

Then open <http://localhost:8080> and complete the setup wizard.

You will need an evaluation licence from <https://my.atlassian.com>. Jira Server
licences are no longer sold, so choose **Data Center** — the REST API surface
this adapter uses is identical, and the evaluation runs 30 days.

The wizard is not scriptable. This is the main reason the container cannot join
the automated loop.

### Point the tool at it

```sh
# In the container, create a project with key PROJ and a couple of issues.
# Then, in your workspace:
```

```yaml
# config.yml
jira:
  base_url: "http://localhost:8080"
  project: "PROJ"
  epic_link_field: null      # doctor will tell you the real id
```

```sh
export JIRA_PAT=...          # Profile → Personal Access Tokens, in the container
mgmt doctor                  # confirms version, deployment type, epic link field
mgmt sync                    # dry run — prints the plan, writes nothing
```

`mgmt doctor` reporting `Server 9.x` and a `customfield_*` id is the signal that
the wiring is right. Record that id in `config.yml`.

### What to check by hand

Compare a pulled ticket file against the same issue in the browser:

- Does the body survive the wiki-markup round trip without accumulating changes?
  Run `mgmt sync` twice — the second run must plan nothing.
- Do non-Latin characters, code blocks and links come back intact?
- Does the estimate land, and in the same unit the browser shows?
- Is the assignee the account name, not a display name?

Anything that disagrees is a fixture that lied. Fix the adapter, then correct the
fixture in `docs/testcase/` so the substitute stops lying too.

### Stop it

```sh
docker compose -f docker-compose.jira.yml down          # keeps the data
docker compose -f docker-compose.jira.yml down -v       # discards it
```

### Optionally, replay the automated cases against it

**This is manual verification, not testing.** The test suite is local-only: it
contacts nothing but loopback, needs no licence, no container and no account,
and both adapters refuse a non-loopback host while tests run (TC-E-SAFE-01c/01d).
A suite that depends on an external service — even indirectly, through a licence
issued by one — fails for reasons unrelated to the code, and then stops being run.

What follows is a check you do deliberately, once, when you want to know whether
the field mapping matches a real instance. Both suites live behind their own
config so that no environment variable can pull a plain `npm test` onto them:

```sh
MGMT_LIVE_JIRA_URL=http://localhost:8080 \
MGMT_LIVE_JIRA_PAT=... \
MGMT_LIVE_JIRA_PROJECT=PROJ \
npm run test:live
```

- `test/live/live-jira.test.ts` — read-only. Asserts *shapes*: deployment type,
  the Epic Link field id, that the mapping loses no required field, and that
  real descriptions survive the round trip. It asserts no value this repository
  chose, because a fixture invented from a specification encodes the guess.
- `test/e2e/intake-flow.test.ts` (TC-E-INTAKE) — the full external-issue path:
  mirror, promote, sync. **It creates issues**, so point it at a throwaway
  project. The external source is always the local mock, never a real
  repository.

A case that passes against the substitute and fails here is the mapping being
wrong, which is the entire reason for running the same assertions twice.

## What never to do

- Do not point the default suite at the container. `npm test` assumes a tracker
  it fully controls and does not clean up after itself; use `npm run test:live`,
  which is written for a shared instance and for a project you can throw away.
- Do not expose port 8080 beyond loopback. The compose file binds `127.0.0.1`
  deliberately.
- Do not reuse a production personal access token here.
