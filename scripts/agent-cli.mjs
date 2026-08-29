#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const supportedClis = ["codex", "claude", "opencode", "gemini", "copilot"];

function usage(stream = process.stdout) {
  stream.write(`usage: agent doctor [--json | --quiet]\n\n`);
  stream.write(`Check shared instructions, skills, MCPs, launch requirements, auth cache, and post-pull hooks.\n\n`);
  stream.write(`Options:\n`);
  stream.write(`  --json    print stable structured output\n`);
  stream.write(`  --quiet   print only actionable failures\n`);
  stream.write(`  -h, --help\n`);
}

export function parseAgentArgs(argv) {
  if (argv.length === 0 || argv[0] === "help" || argv.includes("-h") || argv.includes("--help")) {
    return { help: true, command: argv[0] || null, json: false, quiet: false };
  }
  if (argv[0] !== "doctor") throw new Error(`unknown command: ${argv[0]}`);
  const options = { help: false, command: "doctor", json: false, quiet: false };
  for (const argument of argv.slice(1)) {
    if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else throw new Error(`unknown option: ${argument}`);
  }
  if (options.json && options.quiet) throw new Error("--json and --quiet cannot be used together");
  return options;
}

function executableExists(command, platform = process.platform, pathValue = process.env.PATH || "") {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const extensions = platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
    : [""];
  return pathValue.split(delimiter).some((directory) =>
    extensions.some((extension) => existsSync(join(directory, command + extension.toLowerCase())) ||
      existsSync(join(directory, command + extension.toUpperCase()))),
  );
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function setupArguments(state) {
  const args = ["--check"];
  if (state.publicOnly) args.push("--public-only");
  if (state.headless) args.push("--headless");
  if (state.cliMode === "all") args.push("--all-clis");
  else if (state.cliMode === "explicit") {
    for (const cli of state.clis || []) args.push("--cli", cli);
  }
  return args;
}

export function userCliPath(userHome, currentPath = "") {
  return [join(userHome, ".local", "bin"), join(userHome, ".npm-global", "bin"), currentPath]
    .filter(Boolean)
    .join(delimiter);
}

function selectedClis(state, platform, pathValue) {
  if (state.cliMode === "all") return supportedClis;
  if (state.cliMode === "explicit") return state.clis || [];
  return supportedClis.filter((cli) => executableExists(cli, platform, pathValue));
}

function runSetupCheck(state, platform, environment) {
  const args = setupArguments(state);
  if (platform === "win32") {
    const cliValues = [];
    const powershellArgs = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolve(repoRoot, "scripts", "setup-windows.ps1"), "-Check"];
    for (let index = 1; index < args.length; index += 1) {
      const argument = args[index];
      if (argument === "--public-only") powershellArgs.push("-PublicOnly");
      else if (argument === "--headless") powershellArgs.push("-Headless");
      else if (argument === "--all-clis") powershellArgs.push("-AllClis");
      else if (argument === "--cli") cliValues.push(args[++index]);
    }
    if (cliValues.length > 0) powershellArgs.push("-Cli", cliValues.join(","));
    return spawnSync("powershell.exe", powershellArgs, { encoding: "utf8", env: environment });
  }
  const setup = platform === "darwin" ? "setup-macos.sh" : "setup-linux.sh";
  return spawnSync("bash", [resolve(repoRoot, "scripts", setup), ...args], {
    encoding: "utf8",
    env: environment,
  });
}

function cacheHasEntries(path) {
  try {
    return readdirSync(path).length > 0;
  } catch {
    return false;
  }
}

export function syncStateCheck(state, now = Date.now()) {
  if (!state) return { status: "warn", detail: "automatic sync has not completed yet" };
  if (state.status !== "ok") {
    return { status: "fail", detail: `automatic sync ${state.status}: ${state.error || "unknown error"}` };
  }
  const age = now - Date.parse(state.finishedAt || "");
  if (!Number.isFinite(age) || age > 2 * 60 * 60 * 1000) {
    return { status: "fail", detail: `automatic sync stale: ${state.finishedAt || "unknown"}` };
  }
  return { status: "pass", detail: `last completed ${state.finishedAt}` };
}

export function repairCommand(profile, platform) {
  const flags = [];
  if (profile.publicOnly) flags.push(platform === "win32" ? "-PublicOnly" : "--public-only");
  if (profile.headless) flags.push(platform === "win32" ? "-Headless" : "--headless");
  if (profile.cliMode === "all") flags.push(platform === "win32" ? "-AllClis" : "--all-clis");
  else if (profile.cliMode === "explicit" && profile.clis.length > 0) {
    if (platform === "win32") flags.push("-Cli", profile.clis.join(","));
    else for (const cli of profile.clis) flags.push("--cli", cli);
  }
  if (platform === "win32") {
    return `powershell -NoProfile -ExecutionPolicy Bypass -File ${resolve(repoRoot, "scripts", "setup-windows.ps1")} ${flags.join(" ")}`.trim();
  }
  const setup = platform === "darwin" ? "setup-macos.sh" : "setup-linux.sh";
  return `${resolve(repoRoot, "scripts", setup)} ${flags.join(" ")}`.trim();
}

export function runDoctor(environment = process.env) {
  const userHome = resolve(environment.AGENT_SETUP_HOME || homedir());
  const doctorEnvironment = {
    ...environment,
    PATH: userCliPath(userHome, environment.PATH || ""),
  };
  const statePath = resolve(environment.AGENT_SETUP_STATE || join(userHome, ".config", "agent", "setup.json"));
  const managerRoot = resolve(environment.MANAGER_REPO_ROOT || join(repoRoot, "..", "manager"));
  const checks = [];
  let state;
  try {
    state = loadJson(statePath);
  } catch {
    state = {
      version: 1,
      platform: process.platform,
      publicOnly: !existsSync(managerRoot),
      headless: false,
      cliMode: "detected",
      clis: [],
    };
  }
  const platform = environment.AGENT_SETUP_PLATFORM || state.platform || process.platform;
  const setup = runSetupCheck(state, platform, doctorEnvironment);
  const setupDetail = [setup.stderr, setup.stdout].filter(Boolean).join("\n").trim();
  checks.push({
    name: "shared-setup",
    status: setup.status === 0 ? "pass" : "fail",
    detail: setup.status === 0 ? "instructions, skills, MCPs, CLI settings, state, and hooks match" : setupDetail || `setup check exited ${setup.status}`,
  });

  const launcher = resolve(repoRoot, "bin", "agent-mcp");
  checks.push({
    name: "mcp-launcher",
    status: existsSync(launcher) ? "pass" : "fail",
    detail: existsSync(launcher) ? launcher : "bin/agent-mcp missing",
  });

  if (platform === "darwin") {
    const syncStatePath = resolve(environment.AGENT_SYNC_STATE || join(userHome, ".local", "state", "agent-sync", "last-run.json"));
    checks.push({ name: "automatic-sync", ...syncStateCheck(readJsonIfPresent(syncStatePath)) });
  }

  const privatePath = resolve(managerRoot, "configs", "mcps.json");
  const servers = !state.publicOnly && existsSync(privatePath) ? loadJson(privatePath).servers || [] : [];
  const clis = selectedClis(state, platform, doctorEnvironment.PATH);
  for (const server of servers) {
    const policy = server.policy || (server.enabled === false ? "on-demand" : "global");
    if (policy !== "global" || (state.headless && server.name === "chrome-devtools")) continue;
    if (!server.clis?.some((cli) => clis.includes(cli))) continue;
    const missing = (server.requires || []).filter((command) => !executableExists(command, platform, doctorEnvironment.PATH));
    checks.push({
      name: `requirements:${server.name}`,
      status: missing.length === 0 ? "pass" : "fail",
      detail: missing.length === 0 ? (server.requires || []).join(", ") || "none" : `missing: ${missing.join(", ")}`,
    });
    if (server.auth?.type === "oauth-cache") {
      const path = resolve(server.auth.path.replaceAll("{home}", userHome));
      checks.push({
        name: `auth:${server.name}`,
        status: cacheHasEntries(path) ? "pass" : "warn",
        detail: cacheHasEntries(path) ? "OAuth cache present; live token checked on connection" : "OAuth cache missing; connect once to authenticate",
      });
    }
  }
  return {
    ok: !checks.some((check) => check.status === "fail"),
    platform,
    profile: {
      publicOnly: Boolean(state.publicOnly),
      headless: Boolean(state.headless),
      cliMode: state.cliMode,
      clis,
    },
    checks,
  };
}

function readJsonIfPresent(path) {
  try {
    return loadJson(path);
  } catch {
    return null;
  }
}

function printHuman(report, quiet) {
  if (quiet) {
    if (!report.ok) {
      for (const check of report.checks.filter((item) => item.status === "fail")) {
        process.stderr.write(`FAIL ${check.name}: ${check.detail}\n`);
      }
      process.stderr.write(`Repair: ${repairCommand(report.profile, report.platform)}\n`);
    }
    return;
  }
  for (const check of report.checks) {
    process.stdout.write(`${check.status.toUpperCase()} ${check.name}: ${check.detail}\n`);
  }
  const warnings = report.checks.filter((check) => check.status === "warn").length;
  process.stdout.write(`Agent doctor: ${report.ok ? "ok" : "failed"}${warnings ? ` (${warnings} warning${warnings === 1 ? "" : "s"})` : ""}\n`);
  if (!report.ok) process.stdout.write(`Repair: ${repairCommand(report.profile, report.platform)}\n`);
}

function main() {
  let options;
  try {
    options = parseAgentArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    usage(process.stderr);
    return 2;
  }
  if (options.help) {
    usage();
    return 0;
  }
  let report;
  try {
    report = runDoctor();
  } catch (error) {
    process.stderr.write(`agent doctor: ${error.message}\n`);
    return 1;
  }
  if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printHuman(report, options.quiet);
  return report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = main();
}
