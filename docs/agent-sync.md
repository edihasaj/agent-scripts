---
summary: "Safe automatic updates and cross-runtime reconciliation for shared agent configuration."
read_when:
  - Changing automatic agent or manager repository updates.
  - Installing or troubleshooting the agent-sync LaunchAgent.
  - Diagnosing stale skills, MCP policy, instructions, or runtime settings.
---

# Agent Sync

`agent-sync` makes `~/Projects/agent` and `~/Projects/manager` behave as one
versioned configuration source without symlinking incompatible runtime configs.

## Behavior

On macOS, setup installs `~/Library/LaunchAgents/com.edihasaj.agent-sync.plist`.
It runs at login and every 30 minutes:

1. Acquire a single-machine lock.
2. Fetch both repositories.
3. Preflight both before changing either one.
4. Fast-forward only clean default branches with no local commits.
5. Re-run the machine's stored setup policy.
6. Verify instructions, skills, MCPs, settings, hooks, and doctor.
7. Record a credential-free result in
   `~/.local/state/agent-sync/last-run.json`.

If either repository is dirty, on another branch, ahead, or diverged, neither
repository is merged. The LaunchAgent retries later. `agent doctor` reports the
blocker and stale runs older than two hours.

Manual pulls use the managed `post-merge`/`post-rewrite` hook to reconcile the
already checked-out versions immediately. Hooks preserve Git's exit status.

## Commands

```bash
~/Projects/agent/bin/agent-sync
~/Projects/agent/bin/agent-sync --reconcile-only
~/Projects/agent/bin/agent-sync --check
~/Projects/agent/bin/agent doctor
```

Logs:

```bash
tail -f ~/.local/state/agent-sync/launchd.log
cat ~/.local/state/agent-sync/last-run.json
launchctl print gui/$(id -u)/com.edihasaj.agent-sync
```

## Adding an MCP later

Add one credential-free entry to `manager/configs/mcps.json`, commit, and push.
Both Macs fetch it automatically. `global` entries are rendered into each
selected runtime; `on-demand` and `workflow` entries are removed from user-global
configuration; `external` entries remain owned by their installer.

Secrets and OAuth caches stay machine-local. A manifest may reference an
environment variable name but never its value.
