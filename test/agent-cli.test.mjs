import assert from "node:assert/strict";
import { delimiter } from "node:path";
import test from "node:test";
import { parseAgentArgs, repairCommand, syncStateCheck, userCliPath } from "../scripts/agent-cli.mjs";

test("agent doctor supports human, JSON, and quiet output modes", () => {
  assert.deepEqual(parseAgentArgs(["doctor"]), {
    help: false,
    command: "doctor",
    json: false,
    quiet: false,
  });
  assert.equal(parseAgentArgs(["doctor", "--json"]).json, true);
  assert.equal(parseAgentArgs(["doctor", "--quiet"]).quiet, true);
  assert.throws(() => parseAgentArgs(["doctor", "--json", "--quiet"]), /cannot be used together/);
  assert.throws(() => parseAgentArgs(["unknown"]), /unknown command/);
});

test("doctor repair commands preserve the stored machine policy", () => {
  const profile = {
    publicOnly: true,
    headless: true,
    cliMode: "explicit",
    clis: ["codex", "claude"],
  };
  assert.match(repairCommand(profile, "linux"), /setup-linux\.sh --public-only --headless --cli codex --cli claude$/);
  assert.match(repairCommand(profile, "win32"), /setup-windows\.ps1 -PublicOnly -Headless -Cli codex,claude$/);
});

test("doctor adds user CLI locations for non-login shells", () => {
  const value = userCliPath("/home/edi", "/usr/bin");
  assert.equal(value, ["/home/edi/.local/bin", "/home/edi/.npm-global/bin", "/usr/bin"].join(delimiter));
});

test("doctor reports automatic sync freshness and blockers", () => {
  const now = Date.parse("2026-08-29T20:00:00Z");
  assert.equal(syncStateCheck({ status: "ok", finishedAt: "2026-08-29T19:30:00Z" }, now).status, "pass");
  assert.equal(syncStateCheck({ status: "ok", finishedAt: "2026-08-29T16:00:00Z" }, now).status, "fail");
  assert.match(syncStateCheck({ status: "blocked", error: "dirty worktree" }, now).detail, /dirty worktree/);
  assert.equal(syncStateCheck(null, now).status, "warn");
});
