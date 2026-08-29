import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { desiredSetupState, launchAgentContents, parseMaintenanceArgs } from "../scripts/sync-agent-maintenance.mjs";

const maintenanceScript = resolve("scripts/sync-agent-maintenance.mjs");

test("maintenance state records setup policy rather than detected executables", () => {
  const options = parseMaintenanceArgs(["--public-only", "--headless", "--cli", "codex"]);
  assert.deepEqual(desiredSetupState(options, "linux"), {
    version: 1,
    platform: "linux",
    publicOnly: true,
    headless: true,
    cliMode: "explicit",
    clis: ["codex"],
  });
});

test("maintenance accepts an empty option list for default desktop setup", () => {
  const options = parseMaintenanceArgs([]);
  assert.deepEqual(desiredSetupState(options, "darwin"), {
    version: 1,
    platform: "darwin",
    publicOnly: false,
    headless: false,
    cliMode: "detected",
    clis: [],
  });
});

test("macOS automatic sync LaunchAgent is deterministic and scoped", () => {
  const plist = launchAgentContents("/Users/edi/Projects/agent", "/Users/edi/Projects/manager", "/Users/edi");
  assert.match(plist, /com\.edihasaj\.agent-sync/);
  assert.match(plist, /\/Users\/edi\/Projects\/agent\/bin\/agent-sync/);
  assert.match(plist, /<integer>1800<\/integer>/);
  assert.match(plist, /AGENT_REPO_ROOT/);
  assert.match(plist, /MANAGER_REPO_ROOT/);
  assert.doesNotMatch(plist, /token|secret|password/i);
});

test("maintenance sync installs hooks for agent and manager and detects drift", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-maintenance-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const agent = join(root, "agent");
  const manager = join(root, "manager");
  const hookSource = join(agent, "scripts", "git-hooks", "post-sync-check");
  mkdirSync(join(agent, "scripts", "git-hooks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(hookSource, "#!/usr/bin/env bash\nexit 0\n");
  chmodSync(hookSource, 0o755);
  for (const repo of [agent, manager]) {
    mkdirSync(repo, { recursive: true });
    assert.equal(spawnSync("git", ["init", "-q", repo]).status, 0);
  }
  const env = {
    ...process.env,
    AGENT_SETUP_HOME: home,
    AGENT_REPO_ROOT: agent,
    MANAGER_REPO_ROOT: manager,
    AGENT_SETUP_PLATFORM: "linux",
  };
  const sync = spawnSync(process.execPath, [maintenanceScript, "--public-only", "--headless"], { encoding: "utf8", env });
  assert.equal(sync.status, 0, sync.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(home, ".config", "agent", "setup.json"), "utf8")), {
    version: 1,
    platform: "linux",
    publicOnly: true,
    headless: true,
    cliMode: "detected",
    clis: [],
  });
  const check = spawnSync(process.execPath, [maintenanceScript, "--check", "--public-only", "--headless"], { encoding: "utf8", env });
  assert.equal(check.status, 0, check.stderr);
  const drift = spawnSync(process.execPath, [maintenanceScript, "--check"], { encoding: "utf8", env });
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /stale setup state/);
});
