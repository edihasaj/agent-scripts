---
summary: "Shared MCP launcher profiles for Claude, Codex, and other agent clients."
read_when:
  - Updating global Claude or Codex MCP settings.
  - Adding or debugging an MCP server profile.
---

# MCP Profiles

Use `~/Projects/agent/bin/agent-mcp <profile>` from global MCP config. Keep AGENTS compact and keep secrets in machine-local shell config, not git.

## Profiles

- `chrome-devtools` -> `chrome-devtools-mcp@1.7.0 --autoConnect`
- `recall` -> local Recall app MCP runtime
- `zapfeed` -> `mcp-remote@0.1.38` to `https://zapfeed.io/api/mcp`
- `miro` -> `mcp-remote@0.1.38` to `https://mcp.miro.com/` (OAuth 2.1 browser login; tokens cached in `~/.mcp-auth`)
- `slack` -> NOT via mcp-remote. Workspace Slack MCP apps commonly enforce a fixed redirect-URI allowlist and reject dynamic client registration, so mcp-remote's random-port `/oauth/callback` never matches (login loops). Use a client with native remote-MCP OAuth (Claude Code / VS Code / GitHub Copilot CLI): pin a fixed callback port + `/callback` path and have the Slack-app admin allowlist it. Workspace-specific client ids live in the private overlay.
- `atlassian` -> `mcp-remote@0.1.38` to `https://mcp.atlassian.com/v1/mcp/authv2` using Streamable HTTP only (Jira + Confluence; OAuth browser login; endpoint-specific DCR/token state cached in `~/.mcp-auth`, so migrating from `/v1/sse` requires one fresh login and leaves the old cache entry unused)
- `stripe` -> `mcp-remote@0.1.38` to `https://mcp.stripe.com` (Stripe hosted remote MCP with OAuth 2.1 browser login and tokens cached in `~/.mcp-auth`; no API key). Stripe's OAuth server only supports the `mcp` scope, so the profile passes `--static-oauth-client-metadata '{"scope":"mcp"}'` — without it mcp-remote's default `openid/email/profile` scopes are rejected and login fails.
- `guiport` -> `guiport serve --mcp`

## Never launch a stdio server through `npx`

Node profiles install a pinned version once into `~/.cache/agent-mcp/pkgs/`
(override with `AGENT_MCP_PKG_ROOT`) and then `exec node` the entry point
directly. `npx -y <pkg>` looks equivalent but is not: it runs the server under
an `npm exec` parent that lives for the whole session, which means

- **two node processes per client session instead of one**, and
- the client's SIGTERM lands on the `npm exec` wrapper, not the server. The
  server is reparented to launchd and keeps running. An OAuth profile orphaned
  this way retries its browser login forever.

Both failure modes were real on 2026-08-17: 92 stray `mcp-remote` procs
(3.8 GB) from a globally-registered Sentry profile, 69 stray
`chrome-devtools-mcp` procs (2.7 GB), and an orphaned Miro profile reopening
the Miro login page indefinitely against a half-registered OAuth client.

Two rules follow:

1. Add node profiles with `exec_npm_bin <pkg@version> <bin> [args...]`, never
   `npx`. Pin the version — the cache key is the full spec.
2. Register OAuth-heavy or occasional profiles per-project, not globally. Every
   client starts *all* configured stdio servers at session start, whether or
   not a tool is ever called, so a global registration is a per-session process
   whether you use it or not.

## On-demand by default

There is no lazy start in the MCP stdio transport: a client boots every
configured server when the session opens and holds it for the session's whole
life. Long-lived Zed/Codex sessions therefore accumulate servers nobody called.
So the default is **not registered**, and you turn one on for the stretch of
work that needs it:

```bash
# Claude Code — add for this session's work, drop it when done
claude mcp add miro -- ~/Projects/agent/bin/agent-mcp miro
claude mcp remove miro -s user

# Claude Code — scope to one repo instead (only sessions in that repo pay)
cd ~/Projects/<repo> && claude mcp add -s project miro -- ~/Projects/agent/bin/agent-mcp miro

# Codex — flip the flag in ~/.codex/config.toml
[mcp_servers.glitchtip]
enabled = true
```

Servers that stay registered globally are only the ones every session genuinely
uses: `recall` / `recall-cloud` (memory, needed at session start) and remote
HTTP entries such as `zapfeed`, which cost no local process at all. Prefer an
`http`/`url` registration over stdio wherever the vendor offers one — it has no
process to strand.

Profiles in the private manifest (`~/Projects/manager/configs/mcps.json`) are
`enabled: false` for the same reason; `sync-agent-mcps` skips a disabled server
rather than registering it.

`load_machine_env` sources `~/.profile` and `~/.zprofile` with `set +eu`. Those
files are written for interactive zsh and commonly pull in snippets that are
not `set -eu` clean (google-cloud-sdk's `path.zsh.inc` dies on an unbound `$1`),
which otherwise kills the launcher before the server starts.

Private/org-specific profiles (and their setup notes) live in the private overlay `~/Projects/manager/scripts/mcp/agent-mcp-private`; the launcher delegates to it automatically when the profile is defined there.

## Managed registrations

The public repository does not keep a second MCP manifest. Runtime-owned MCPs,
hosted connectors, and plugins remain visible through each client's MCP list.
Agent setup changes only the private registrations declared in
`~/Projects/manager/configs/mcps.json`.

`chrome-devtools` remains an optional launcher profile for explicit fallback
use, but setup does not register it globally. Recall owns its own registration
through `recall setup`. OAuth-heavy and project-specific profiles remain opt-in
to avoid loading unused tools in every session.

```bash
~/Projects/agent/bin/sync-agent-mcps
~/Projects/agent/bin/sync-agent-mcps --check
~/Projects/agent/bin/sync-agent-mcps --public-only --cli codex
```

The synchronizer supports Codex, Claude, Gemini, GitHub Copilot, and OpenCode.
It owns only names present in the private manifest. Other user entries, Codex app MCPs,
hosted connectors/plugins, and repository `.mcp.json` files are preserved.
OpenCode JSONC configs are reported for manual merge instead of being rewritten
without their comments.

Manifest command arrays use `{repo}` and `{home}` placeholders and provide
`posix` and `windows` variants. `requires` lists executable prerequisites; a
missing prerequisite skips that registration without breaking instruction or
skill setup. `replaces` lists old registration names for automatic migrations.
`--exclude NAME` removes a managed registration instead of merely skipping it.
Never put credentials in the manifest.

Runtime npm packages use reviewed exact versions rather than floating tags.
Check upstream releases deliberately, update the launcher and platform command
together, then run the setup regression suite before rollout.

### Miro item mutations

The hosted Miro MCP does not move or delete items. Use the
`miro-board-ops` skill for those REST operations; it bundles the CLI, auth
requirements, target-resolution workflow, and destructive-action guardrails.

## Secrets

Store reusable machine-local exports in `~/.profile` or `~/.zprofile`, for example:

```bash
export ZAPFEED_API_KEY="..."
```

The launcher sources those files at MCP startup. This fixes GUI or daemon-launched agents that do not inherit shell profile env.

Do not commit API keys, bearer tokens, 1Password item IDs, or generated MCP auth caches. If a secret is only in 1Password, pull it into the machine-local profile manually or with a targeted tmux-backed `op` flow, then restart the MCP client.

The public launcher and private GlitchTip overlay load NVM's `nvm.sh` when
`npx` is absent from a GUI or non-login shell `PATH`.

## Global Config Snippets

Claude-style JSON:

```json
{
  "mcpServers": {
    "zapfeed": {
      "command": "/Users/edi/Projects/agent/bin/agent-mcp",
      "args": ["zapfeed"]
    }
  }
}
```

Codex TOML:

```toml
[mcp_servers.zapfeed]
command = "/Users/edi/Projects/agent/bin/agent-mcp"
args = ["zapfeed"]
```

## Checks

```bash
~/Projects/agent/bin/agent-mcp --help
~/Projects/agent/bin/sync-agent-mcps --check
~/Projects/agent/bin/agent doctor
~/Projects/agent/bin/agent doctor --json
ssh -o BatchMode=yes -o RequestTTY=no -o RemoteCommand=none studio 'hostname'
obsidian vaults
```

The platform setup records its public/private, headless, and CLI-selection
policy in `~/.config/agent/setup.json`. Managed Git hooks run the quiet doctor
after pulls or rebases of either `agent` or `manager`; they report drift without
changing configuration or failing the Git operation.
