#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultAgentRoot = resolve(dirname(scriptPath), "..");

function usage(stream = process.stdout) {
  stream.write("usage: agent-sync [--reconcile-only] [--check] [--quiet]\n");
}

export function parseSyncArgs(argv) {
  const options = { reconcileOnly: false, check: false, quiet: false };
  for (const argument of argv) {
    if (argument === "--reconcile-only") options.reconcileOnly = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "-h" || argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.check && options.reconcileOnly) throw new Error("--check and --reconcile-only cannot be combined");
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env || process.env,
  });
  if (result.error) throw new Error(`${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim().split("\n").at(-1);
    throw new Error(`${command} ${args.join(" ")}: ${detail}`);
  }
  return result.stdout.trim();
}

function git(root, args, environment) {
  return run("git", ["-C", root, ...args], { env: environment });
}

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function setupArgs(state) {
  const args = [];
  if (state.publicOnly) args.push("--public-only");
  if (state.headless) args.push("--headless");
  if (state.cliMode === "all") args.push("--all-clis");
  else if (state.cliMode === "explicit") {
    for (const cli of state.clis || []) args.push("--cli", cli);
  }
  return args;
}

function defaultBranch(root, environment) {
  try {
    const ref = git(root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], environment);
    if (ref.startsWith("origin/")) return ref.slice("origin/".length);
  } catch {
    // Older clones may not have origin/HEAD; these repos use main.
  }
  return "main";
}

export function inspectRepo(root, environment = process.env, fetch = false) {
  if (!existsSync(join(root, ".git"))) throw new Error(`not a Git checkout: ${root}`);
  const dirty = git(root, ["status", "--porcelain", "--untracked-files=normal"], environment);
  const branch = git(root, ["branch", "--show-current"], environment);
  const expected = defaultBranch(root, environment);
  if (fetch) git(root, ["fetch", "--prune", "origin"], environment);
  const counts = git(root, ["rev-list", "--left-right", "--count", `HEAD...origin/${expected}`], environment)
    .split(/\s+/)
    .map((value) => Number.parseInt(value, 10));
  return {
    root,
    branch,
    expected,
    dirty: Boolean(dirty),
    ahead: counts[0] || 0,
    behind: counts[1] || 0,
    commit: git(root, ["rev-parse", "HEAD"], environment),
  };
}

function validateRepos(repos) {
  const problems = [];
  for (const repo of repos) {
    if (repo.dirty) problems.push(`${repo.root}: dirty worktree`);
    if (repo.branch !== repo.expected) problems.push(`${repo.root}: branch=${repo.branch || "detached"}, expected=${repo.expected}`);
    if (repo.ahead > 0) problems.push(`${repo.root}: ${repo.ahead} unpushed commit(s)`);
  }
  if (problems.length > 0) throw new Error(`automatic sync blocked; ${problems.join("; ")}`);
}

function acquireLock(path) {
  mkdirSync(dirname(path), { recursive: true });
  try {
    mkdirSync(path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let pid = 0;
    try {
      pid = Number.parseInt(readFileSync(join(path, "pid"), "utf8"), 10);
    } catch {
      pid = 0;
    }
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        throw new Error(`agent-sync already running as pid ${pid}`);
      } catch (check) {
        if (check.code !== "ESRCH") throw check;
      }
    }
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);
  }
  writeFileSync(join(path, "pid"), `${process.pid}\n`, { mode: 0o600 });
}

function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

export function runAgentSync(argv = process.argv.slice(2), environment = process.env) {
  const options = parseSyncArgs(argv);
  const userHome = resolve(environment.AGENT_SETUP_HOME || homedir());
  const agentRoot = resolve(environment.AGENT_REPO_ROOT || defaultAgentRoot);
  const managerRoot = resolve(environment.MANAGER_REPO_ROOT || join(agentRoot, "..", "manager"));
  const setupStatePath = resolve(environment.AGENT_SETUP_STATE || join(userHome, ".config", "agent", "setup.json"));
  const statePath = resolve(environment.AGENT_SYNC_STATE || join(userHome, ".local", "state", "agent-sync", "last-run.json"));
  const lockPath = resolve(environment.AGENT_SYNC_LOCK || join(userHome, ".local", "state", "agent-sync", "lock"));
  const setupState = readJson(setupStatePath, {
    platform: process.platform,
    publicOnly: !existsSync(managerRoot),
    headless: false,
    cliMode: "detected",
    clis: [],
  });

  if (options.check) {
    const last = readJson(statePath);
    if (!last) throw new Error(`agent-sync has never completed: ${statePath}`);
    if (last.status !== "ok") throw new Error(`last agent-sync status=${last.status}: ${last.error || "unknown error"}`);
    const ageMs = Date.now() - Date.parse(last.finishedAt || "");
    if (!Number.isFinite(ageMs) || ageMs > 2 * 60 * 60 * 1000) {
      throw new Error(`last agent-sync is stale: ${last.finishedAt || "unknown"}`);
    }
    if (!options.quiet) process.stdout.write(`agent-sync check ok: ${last.finishedAt}\n`);
    return 0;
  }

  acquireLock(lockPath);
  const startedAt = new Date().toISOString();
  const syncEnvironment = { ...environment, AGENT_DOCTOR_SKIP_HOOK: "1", AGENT_SYNC_ACTIVE: "1" };
  try {
    const roots = [agentRoot];
    if (!setupState.publicOnly && existsSync(managerRoot)) roots.push(managerRoot);
    let repos = roots.map((root) => inspectRepo(root, syncEnvironment, !options.reconcileOnly));
    validateRepos(repos);
    if (!options.reconcileOnly) {
      for (const repo of repos.filter((item) => item.behind > 0)) {
        git(repo.root, ["merge", "--ff-only", `origin/${repo.expected}`], syncEnvironment);
      }
      repos = roots.map((root) => inspectRepo(root, syncEnvironment, false));
      validateRepos(repos);
    }

    const platform = setupState.platform || process.platform;
    const setup = platform === "darwin" ? "setup-macos.sh" : platform === "linux" ? "setup-linux.sh" : null;
    if (!setup) throw new Error(`automatic setup unsupported on platform: ${platform}`);
    run(resolve(agentRoot, "scripts", setup), setupArgs(setupState), { env: syncEnvironment });
    run(process.execPath, [resolve(agentRoot, "scripts", "agent-cli.mjs"), "doctor", "--quiet"], { env: syncEnvironment });
    const state = {
      version: 1,
      status: "ok",
      trigger: options.reconcileOnly ? "reconcile" : "scheduled",
      startedAt,
      finishedAt: new Date().toISOString(),
      repos: repos.map(({ root, branch, commit }) => ({ root, branch, commit })),
    };
    writeState(statePath, state);
    if (!options.quiet) process.stdout.write(`agent-sync complete: ${state.finishedAt}\n`);
    return 0;
  } catch (error) {
    writeState(statePath, {
      version: 1,
      status: "blocked",
      trigger: options.reconcileOnly ? "reconcile" : "scheduled",
      startedAt,
      finishedAt: new Date().toISOString(),
      error: error.message,
    });
    process.stderr.write(`agent-sync: ${error.message}\n`);
    return 3;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runAgentSync();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    usage(process.stderr);
    process.exitCode = 2;
  }
}
