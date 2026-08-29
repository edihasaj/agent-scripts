#!/usr/bin/env node

import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRepoRoot = resolve(dirname(scriptPath), "..");
const supportedClis = ["codex", "claude", "opencode", "gemini", "copilot"];

function usage(stream = process.stdout) {
  stream.write("usage: sync-agent-maintenance [--check] [--public-only] [--headless] [--all-clis] [--cli NAME]...\n");
}

export function parseMaintenanceArgs(argv) {
  const options = {
    check: false,
    publicOnly: false,
    headless: false,
    allClis: false,
    clis: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--check") options.check = true;
    else if (argument === "--public-only") options.publicOnly = true;
    else if (argument === "--headless") options.headless = true;
    else if (argument === "--all-clis") options.allClis = true;
    else if (argument === "--cli") {
      const cli = argv[index + 1];
      if (!cli) throw new Error("--cli requires a value");
      if (!supportedClis.includes(cli)) throw new Error(`unsupported CLI: ${cli}`);
      if (!options.clis.includes(cli)) options.clis.push(cli);
      index += 1;
    } else if (argument === "-h" || argument === "--help") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.allClis && options.clis.length > 0) {
    throw new Error("--all-clis and --cli cannot be used together");
  }
  return options;
}

export function desiredSetupState(options, platform = process.platform) {
  return {
    version: 1,
    platform,
    publicOnly: options.publicOnly,
    headless: options.headless,
    cliMode: options.allClis ? "all" : options.clis.length > 0 ? "explicit" : "detected",
    clis: options.clis,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function gitHookPath(repoRoot, hookName) {
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "--git-path", `hooks/${hookName}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function hookMatches(path, source, platform) {
  if (!pathExists(path)) return false;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(path);
    return resolve(dirname(path), target) === source;
  }
  if (platform === "win32" && stat.isFile()) {
    return readFileSync(path, "utf8") === readFileSync(source, "utf8");
  }
  return false;
}

function syncHook(repoRoot, hookName, source, options, platform) {
  const path = gitHookPath(repoRoot, hookName);
  if (!path) return { status: "skip", detail: `${repoRoot}: not a git checkout` };
  if (hookMatches(path, source, platform)) {
    return { status: "match", detail: path };
  }
  if (pathExists(path)) {
    return { status: "fail", detail: `kept unmanaged hook: ${path}` };
  }
  if (options.check) return { status: "fail", detail: `missing hook: ${path}` };
  mkdirSync(dirname(path), { recursive: true });
  if (platform === "win32") copyFileSync(source, path);
  else symlinkSync(source, path);
  chmodSync(path, 0o755);
  return { status: "changed", detail: path };
}

function xml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function launchAgentContents(repoRoot, managerRoot, userHome) {
  const label = "com.edihasaj.agent-sync";
  const logPath = join(userHome, ".local", "state", "agent-sync", "launchd.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(resolve(repoRoot, "bin", "agent-sync"))}</string>
    <string>--quiet</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENT_REPO_ROOT</key>
    <string>${xml(repoRoot)}</string>
    <key>MANAGER_REPO_ROOT</key>
    <string>${xml(managerRoot)}</string>
    <key>PATH</key>
    <string>${xml(`${join(userHome, ".local", "bin")}:${join(userHome, ".npm-global", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>1800</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

function launchAgentLoaded(label) {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid == null) return false;
  return spawnSync("launchctl", ["print", `gui/${uid}/${label}`], { encoding: "utf8" }).status === 0;
}

function syncLaunchAgent(repoRoot, managerRoot, userHome, options, platform, environment) {
  if (platform !== "darwin") return { status: "skip", detail: "automatic sync LaunchAgent is macOS-only" };
  const label = "com.edihasaj.agent-sync";
  const path = join(userHome, "Library", "LaunchAgents", `${label}.plist`);
  const expected = launchAgentContents(repoRoot, managerRoot, userHome);
  const matches = existsSync(path) && readFileSync(path, "utf8") === expected;
  const loaded = environment.AGENT_SETUP_NO_LAUNCHCTL === "1" ? true : launchAgentLoaded(label);
  if (matches && loaded) return { status: "match", detail: path };
  if (options.check) {
    return { status: "fail", detail: !matches ? `missing or stale LaunchAgent: ${path}` : `LaunchAgent not loaded: ${label}` };
  }
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(join(userHome, ".local", "state", "agent-sync"), { recursive: true });
  if (!matches) {
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, expected, { mode: 0o644 });
    renameSync(temporary, path);
  }
  if (environment.AGENT_SETUP_NO_LAUNCHCTL !== "1") {
    const uid = process.getuid();
    spawnSync("launchctl", ["bootout", `gui/${uid}`, path], { encoding: "utf8" });
    const bootstrap = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, path], { encoding: "utf8" });
    if (bootstrap.status !== 0) {
      const detail = (bootstrap.stderr || bootstrap.stdout || "launchctl bootstrap failed").trim();
      return { status: "fail", detail: `${label}: ${detail}` };
    }
  }
  return { status: "changed", detail: path };
}

export function runMaintenance(argv = process.argv.slice(2), environment = process.env) {
  const options = parseMaintenanceArgs(argv);
  const platform = environment.AGENT_SETUP_PLATFORM || process.platform;
  const userHome = resolve(environment.AGENT_SETUP_HOME || homedir());
  const repoRoot = resolve(environment.AGENT_REPO_ROOT || defaultRepoRoot);
  const managerRoot = resolve(environment.MANAGER_REPO_ROOT || join(repoRoot, "..", "manager"));
  const statePath = resolve(environment.AGENT_SETUP_STATE || join(userHome, ".config", "agent", "setup.json"));
  const expectedState = desiredSetupState(options, platform);
  const results = [];

  let currentState = null;
  if (existsSync(statePath)) {
    try {
      currentState = JSON.parse(readFileSync(statePath, "utf8"));
    } catch {
      currentState = null;
    }
  }
  if (sameJson(currentState, expectedState)) {
    results.push({ status: "match", detail: statePath });
  } else if (options.check) {
    results.push({ status: "fail", detail: `missing or stale setup state: ${statePath}` });
  } else {
    mkdirSync(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(expectedState, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, statePath);
    results.push({ status: "changed", detail: statePath });
  }

  const hookSource = resolve(repoRoot, "scripts", "git-hooks", "post-sync-check");
  if (!existsSync(hookSource)) {
    results.push({ status: "fail", detail: `hook source missing: ${hookSource}` });
  } else {
    for (const root of [repoRoot, managerRoot]) {
      if (!existsSync(root)) continue;
      for (const hookName of ["post-merge", "post-rewrite"]) {
        results.push(syncHook(root, hookName, hookSource, options, platform));
      }
    }
  }

  results.push(syncLaunchAgent(repoRoot, managerRoot, userHome, options, platform, environment));

  const failures = results.filter((result) => result.status === "fail");
  for (const result of results) {
    if (result.status === "fail") process.stderr.write(`${result.detail}\n`);
    else if (!options.check && result.status === "changed") process.stdout.write(`updated: ${result.detail}\n`);
  }
  const matched = results.filter((result) => result.status === "match").length;
  const changed = results.filter((result) => result.status === "changed").length;
  process.stdout.write(`maintenance ${options.check ? "check" : "sync"} complete: matched=${matched} changed=${changed} failures=${failures.length}\n`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    process.exitCode = runMaintenance();
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    usage(process.stderr);
    process.exitCode = 2;
  }
}
