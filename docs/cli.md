# CLI

```sh
mgmt sync                  # pull external + pull tracker + push tracker — DRY RUN
mgmt sync --apply          # actually perform it
mgmt sync --only jira      # restrict to one side
mgmt sync --limit 10       # cap the number of tickets touched (blast-radius control)

mgmt pull github [--full]  # --full reconciles deleted/transferred issues

mgmt promote issues/<file> [--type Task] [--parent PROJ-100]
mgmt new "title" [--type Sub-task] [--parent PROJ-123]     # creates LOCAL-nnnn

mgmt resolve <id> --take local | --take jira | --done

mgmt index                 # regenerate INDEX.md
mgmt status                # pending pushes, conflicts, cursor positions
mgmt doctor                # tokens, server version, custom field ids, permissions

mgmt init                  # scaffold a workspace
mgmt upgrade               # refresh agent templates to match the installed CLI
mgmt migrate               # raise the workspace schema_version
mgmt --version
```

## Dry-run is the default

Every command that could write requires `--apply`. This is the primary safeguard: a bug
in field mapping or merge logic damages real tickets in a shared system, and those
edits are not easily undone.

`mgmt sync` prints the plan it would execute. `mgmt sync --apply` executes *that same
plan object* — the preview and the action cannot diverge.

## Workspace discovery

The CLI is installed globally, so it has to find the data. In order:

1. `--workspace <path>`
2. `MGMT_WORKSPACE` environment variable
3. walking up from the current directory until a `config.yml` containing a `mgmt:` key
   is found — the same way git locates `.git`
4. otherwise: fail with a message pointing at `mgmt init`

Step 3 means the command works from any subdirectory of the workspace.

## Output

Human-readable tables by default. `--json` emits the `SyncPlan` / result as JSON for
scripts, CI, and coding agents. Both come from the same object.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | success; nothing needed doing, or `--apply` completed cleanly |
| 1 | unexpected error (network, auth, malformed data) |
| 2 | conflicts present — sync completed for other tickets, these need a human |
| 3 | version incompatibility between CLI and workspace `schema_version` |

Code 2 matters for automation: a scheduled run should surface conflicts as an alert
without treating the whole run as a failure.

## Safety rules

- Nothing is ever deleted. Closed tickets move to `archive/`.
- A remote returning fewer tickets than expected never causes local deletion.
- Version compatibility is checked before every command, including read-only ones, and
  cannot be bypassed with a flag.
- Scheduled runs should pin an exact CLI version. A cron job that upgrades itself
  overnight and breaks is the worst failure mode available.
