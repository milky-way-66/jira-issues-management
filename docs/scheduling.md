# Running sync on a schedule

A scheduled sync is optional, off by default, and meant to run on **one** machine.

Several machines syncing the same workspace on a timer do not sync it faster;
they produce conflicting commits, because each one commits its own view of the
tracker at a slightly different moment. Pick one person's machine.

## The toggle

```yaml
# config.yml
sync:
  scheduled: true
```

`mgmt sync --apply --scheduled` does nothing while this is `false`, and exits 0.
That is the point: the cron entry can be installed once and left inert. Turning
the schedule on or off is a one-line change in a file that is already under
version control, rather than a crontab edit nobody else can see.

Exit 0 rather than an error is deliberate too — a disabled schedule is a
decision, and a nonzero code would page someone every interval.

## cron (Linux, macOS)

```sh
crontab -e
```

```cron
*/15 * * * * cd /path/to/workspace && /usr/local/bin/mgmt sync --apply --scheduled >> .sync/cron.log 2>&1
```

Notes that matter:

- **Use the absolute path to `mgmt`.** cron runs with a minimal `PATH`; a bare
  `mgmt` usually resolves to nothing and fails silently. `which mgmt` gives you
  the path.
- **`JIRA_PAT` will not be set.** cron does not read your shell profile. Either
  export it in the crontab, or — better — keep it in the workspace `.env`, which
  is gitignored.
- **Pin the CLI version.** A scheduled job that upgrades itself overnight and
  breaks is the worst failure mode available. `cli_range` in `config.yml` already
  refuses a CLI outside the allowed range, with exit code 3.

## launchd (macOS, survives sleep better)

`~/Library/LaunchAgents/com.example.mgmt-sync.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.example.mgmt-sync</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/mgmt</string>
    <string>sync</string>
    <string>--apply</string>
    <string>--scheduled</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/workspace</string>
  <key>StartInterval</key><integer>900</integer>
  <key>StandardOutPath</key><string>/path/to/workspace/.sync/cron.log</string>
  <key>StandardErrorPath</key><string>/path/to/workspace/.sync/cron.log</string>
</dict>
</plist>
```

```sh
launchctl load ~/Library/LaunchAgents/com.example.mgmt-sync.plist
```

Unlike cron, launchd runs a job that was missed while the machine was asleep.

## Committing what the sync produced

The sync writes files; it does not commit them. That is left to you on purpose —
a tool that commits on your behalf will eventually commit something you did not
want to keep.

If you do want it automatic, wrap it:

```sh
#!/bin/sh
set -e
cd /path/to/workspace
mgmt sync --apply --scheduled
git diff --quiet && git diff --cached --quiet && exit 0   # nothing changed
git add -A
git commit -q -m "sync: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git push -q
```

The `git diff --quiet` guard is what keeps this from producing an empty commit
every interval. An idle sync writes nothing at all — there is a test that runs
twenty consecutive syncs and asserts the workspace stays byte-identical — so the
guard should fire on almost every run.

## Watching for trouble

Exit codes are the interface:

| Code | Meaning | What a monitor should do |
| --- | --- | --- |
| 0 | fine, or the schedule is disabled | nothing |
| 2 | conflicts; the rest synced | notify — a human has to decide |
| 3 | CLI/workspace version mismatch | notify; do not retry |
| 1 | failure | notify if it repeats |

Code 2 is the reason conflicts are not folded into code 1: a scheduled run
should surface them as an alert without reporting the whole run as broken.

## Turning it off

```yaml
sync:
  scheduled: false
```

The job keeps running and keeps doing nothing. Remove the crontab entry when you
are sure you are done with it.
