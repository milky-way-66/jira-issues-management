# Testing against a real Jira, locally

There are two ways to run this tool without touching a production tracker. They
answer different questions, and using the wrong one wastes a lot of time.

| | Substitute (`test/support/fake-jira.ts`) | Docker instance |
| --- | --- | --- |
| Answers | "is the logic correct?" | "does the mapping match reality?" |
| Setup | none | licence, 2 GB RAM, ~10 min |
| Speed | milliseconds | minutes |
| In CI | yes | no |
| Use it | constantly | once per phase |

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

## What never to do

- Do not point the test suite at the container by setting `NODE_ENV`. The
  loopback guard permits it, but the suite assumes an empty tracker it fully
  controls and will not clean up after itself.
- Do not expose port 8080 beyond loopback. The compose file binds `127.0.0.1`
  deliberately.
- Do not reuse a production personal access token here.
