import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXPECTED_SERVER_VERSION = "0.3.1";

export const REQUIRED_UPSTREAM_FILES = [
  { path: "bootstrap.js", markers: ["createPaseoDaemon"] },
  { path: "session.js", markers: ["export class Session"] },
  { path: "agent/providers/codex-app-server-agent.js", markers: ["CodexAppServerAgent"] },
  { path: "agent/provider-launch-config.js", markers: ["ProviderOverrideSchema"] },
  {
    path: "agent/provider-snapshot-manager.js",
    markers: ["listRegisteredProviderIds", "getAgentManagerProviderState", "refreshSettingsSnapshot"],
  },
  { path: "web-ui.js", markers: ["createWebUiMiddleware"] },
];

function readJson(filePath) {
  try { return JSON.parse(readFileSync(filePath, "utf8")); } catch { return null; }
}

function serverCodeRoot(serverRoot) {
  return path.join(serverRoot, "dist", "server", "server");
}

export function analyzeUpstream(serverRoot) {
  const resolvedRoot = path.resolve(serverRoot);
  const packageJson = readJson(path.join(resolvedRoot, "package.json"));
  const version = typeof packageJson?.version === "string" ? packageJson.version : null;
  const versionMismatch = version === EXPECTED_SERVER_VERSION
    ? null
    : { expected: EXPECTED_SERVER_VERSION, actual: version ?? "unknown" };
  const missing = [];
  const details = [];
  const codeRoot = serverCodeRoot(resolvedRoot);

  for (const entry of REQUIRED_UPSTREAM_FILES) {
    const filePath = path.join(codeRoot, entry.path);
    if (!existsSync(filePath)) {
      missing.push(entry.path);
      details.push({ path: entry.path, ok: false, reason: "file missing" });
      continue;
    }
    const source = readFileSync(filePath, "utf8");
    const absentMarkers = entry.markers.filter((marker) => !source.includes(marker));
    if (absentMarkers.length) {
      missing.push(entry.path);
      details.push({ path: entry.path, ok: false, reason: "marker missing", markers: absentMarkers });
    } else {
      details.push({ path: entry.path, ok: true, markers: entry.markers });
    }
  }

  return {
    status: versionMismatch || missing.length ? "review-required" : "supported",
    serverRoot: resolvedRoot,
    version,
    expectedVersion: EXPECTED_SERVER_VERSION,
    versionMismatch,
    missing,
    details,
  };
}

function npmGlobalRoot() {
  try { return execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(); } catch { return ""; }
}

export function findUpstreamServerRoot(explicit) {
  const globalRoot = npmGlobalRoot();
  const executablePrefix = path.resolve(path.dirname(process.execPath), "..");
  const candidates = [
    explicit,
    process.env.PASEO_SERVER_ROOT,
    process.env.PREFIX && path.join(process.env.PREFIX, "lib", "node_modules", "@getpaseo", "server"),
    path.join(executablePrefix, "lib", "node_modules", "@getpaseo", "server"),
    globalRoot && path.join(globalRoot, "@getpaseo", "server"),
    globalRoot && path.join(globalRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
    path.join(homedir(), ".npm-global", "lib", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
  ].filter(Boolean).map((candidate) => path.resolve(candidate));
  const found = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!found) throw new Error("找不到 @getpaseo/server，请使用 --server-root 指定其目录。");
  return found;
}

function option(name) {
  const args = process.argv.slice(2);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    const report = analyzeUpstream(findUpstreamServerRoot(option("--server-root")));
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Paseo upstream compatibility: ${report.status}`);
      console.log(`Server: ${report.serverRoot}`);
      console.log(`Version: ${report.version ?? "unknown"} (expected ${report.expectedVersion})`);
      if (report.versionMismatch) console.log(`Version drift: ${report.versionMismatch.actual} -> review the patch files before installing.`);
      if (report.missing.length) console.log(`Missing or changed entry points: ${report.missing.join(", ")}`);
      if (report.status === "supported") console.log("The pinned enhanced patches can be applied after a backup.");
    }
    if (report.status !== "supported") process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
