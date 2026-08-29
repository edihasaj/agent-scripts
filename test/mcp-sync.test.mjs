import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { cliAddArgs, desiredConfig, loadManifest, normalize, sameConfig } from "../scripts/sync-agent-mcps.mjs";

const script = resolve("scripts/sync-agent-mcps.mjs");

test("manifest v2 normalizes policy and bearer environment auth", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-mcp-manifest-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "mcps.json");
  writeFileSync(path, JSON.stringify({
    version: 2,
    servers: [
      {
        name: "zapfeed",
        policy: "global",
        clis: ["codex", "claude"],
        transport: "http",
        url: "https://zapfeed.io/api/mcp",
        auth: { type: "bearer-env", env: "ZAPFEED_API_KEY" },
      },
      { name: "miro", policy: "on-demand", clis: ["claude"], transport: "http", url: "https://mcp.miro.com/" },
    ],
  }));

  const servers = loadManifest(path, true);
  assert.equal(servers[0].policy, "global");
  assert.deepEqual(desiredConfig(servers[0]), {
    transport: "http",
    url: "https://zapfeed.io/api/mcp",
    auth: { type: "bearer-env", env: "ZAPFEED_API_KEY" },
  });
  assert.equal(servers[1].policy, "on-demand");
});

test("normalization distinguishes environment auth from embedded secrets", () => {
  const desired = {
    transport: "http",
    url: "https://zapfeed.io/api/mcp",
    auth: { type: "bearer-env", env: "ZAPFEED_API_KEY" },
  };
  assert.equal(sameConfig(normalize({
    type: "http",
    url: "https://zapfeed.io/api/mcp",
    headers: { Authorization: "Bearer ${ZAPFEED_API_KEY}" },
  }), desired), true);
  assert.equal(sameConfig(normalize({
    type: "http",
    url: "https://zapfeed.io/api/mcp",
    headers: { Authorization: "Bearer secret-value" },
  }), desired), false);
});

test("Claude bearer header follows positional server arguments", () => {
  const args = cliAddArgs("claude", "zapfeed", {
    transport: "http",
    url: "https://zapfeed.io/api/mcp",
    auth: { type: "bearer-env", env: "ZAPFEED_API_KEY" },
  });
  assert.deepEqual(args.slice(0, 8), [
    "mcp", "add", "-s", "user", "--transport", "http", "zapfeed", "https://zapfeed.io/api/mcp",
  ]);
  assert.deepEqual(args.slice(8), ["--header", "Authorization: Bearer ${ZAPFEED_API_KEY}"]);
});

test("check rejects a user-global on-demand MCP without launching it", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-mcp-check-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/usr/bin/env bash\nexit 99\n");
  chmodSync(claude, 0o755);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { miro: { type: "http", url: "https://mcp.miro.com/" } },
  }));
  const manifest = join(root, "mcps.json");
  writeFileSync(manifest, JSON.stringify({
    version: 2,
    servers: [{ name: "miro", policy: "on-demand", clis: ["claude"], transport: "http", url: "https://mcp.miro.com/" }],
  }));

  const result = spawnSync(process.execPath, [script, "--check", "--cli", "claude"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_SETUP_HOME: home,
      PRIVATE_MCPS_CONFIG: manifest,
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unexpected: claude\/miro policy=on-demand/);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers, {
    miro: { type: "http", url: "https://mcp.miro.com/" },
  });
});

test("check flags unknown enabled global stdio without deleting it", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-mcp-unmanaged-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  const claude = join(bin, "claude");
  writeFileSync(claude, "#!/usr/bin/env bash\nexit 99\n");
  chmodSync(claude, 0o755);
  writeFileSync(join(home, ".claude.json"), JSON.stringify({
    mcpServers: { surprise: { type: "stdio", command: "/tmp/surprise", args: [] } },
  }));
  const manifest = join(root, "mcps.json");
  writeFileSync(manifest, JSON.stringify({ version: 2, servers: [] }));

  const result = spawnSync(process.execPath, [script, "--check", "--cli", "claude"], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_SETUP_HOME: home,
      PRIVATE_MCPS_CONFIG: manifest,
      PATH: `${bin}:${process.env.PATH || ""}`,
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unmanaged-global-stdio: claude\/surprise/);
  assert.match(readFileSync(join(home, ".claude.json"), "utf8"), /surprise/);
});
