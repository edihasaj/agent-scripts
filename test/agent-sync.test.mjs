import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { inspectRepo, parseSyncArgs } from "../scripts/agent-sync.mjs";

const script = resolve("scripts/agent-sync.mjs");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("automatic sync arguments keep fetch and reconcile modes separate", () => {
  assert.deepEqual(parseSyncArgs([]), { reconcileOnly: false, check: false, quiet: false });
  assert.equal(parseSyncArgs(["--reconcile-only", "--quiet"]).reconcileOnly, true);
  assert.throws(() => parseSyncArgs(["--check", "--reconcile-only"]), /cannot be combined/);
});

test("repository inspection detects clean, behind, and dirty states", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-sync-git-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const local = join(root, "local");
  const peer = join(root, "peer");
  git(["init", "--bare", "--initial-branch=main", origin], root);
  git(["clone", origin, local], root);
  git(["config", "user.name", "Test"], local);
  git(["config", "user.email", "test@example.com"], local);
  writeFileSync(join(local, "README.md"), "one\n");
  git(["add", "README.md"], local);
  git(["commit", "-m", "initial"], local);
  git(["push", "-u", "origin", "main"], local);

  const clean = inspectRepo(local, process.env, true);
  assert.equal(clean.dirty, false);
  assert.equal(clean.ahead, 0);
  assert.equal(clean.behind, 0);

  git(["clone", origin, peer], root);
  git(["config", "user.name", "Test"], peer);
  git(["config", "user.email", "test@example.com"], peer);
  writeFileSync(join(peer, "README.md"), "two\n");
  git(["add", "README.md"], peer);
  git(["commit", "-m", "second"], peer);
  git(["push", "origin", "main"], peer);
  const behind = inspectRepo(local, process.env, true);
  assert.equal(behind.behind, 1);

  writeFileSync(join(local, "local.txt"), "dirty\n");
  assert.equal(inspectRepo(local).dirty, true);
});

test("automatic sync check accepts a recent successful state", (context) => {
  const root = mkdtempSync(join(tmpdir(), "agent-sync-state-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const state = join(home, ".local", "state", "agent-sync", "last-run.json");
  mkdirSync(resolve(state, ".."), { recursive: true });
  writeFileSync(state, JSON.stringify({ status: "ok", finishedAt: new Date().toISOString() }));
  const result = spawnSync(process.execPath, [script, "--check"], {
    encoding: "utf8",
    env: { ...process.env, AGENT_SETUP_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /agent-sync check ok/);
});

