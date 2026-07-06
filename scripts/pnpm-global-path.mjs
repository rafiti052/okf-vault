import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync as defaultSpawnSync } from "node:child_process";

const GLOBAL_BIN_NOT_IN_PATH_PATTERN =
  /The configured global bin directory "([^"]+)" is not in PATH/i;

/**
 * @param {string} [pathEnv]
 * @returns {string[]}
 */
export function parsePathEntries(pathEnv = process.env.PATH ?? "") {
  const separator = process.platform === "win32" ? ";" : ":";
  return pathEnv.split(separator).filter(Boolean);
}

/**
 * @param {string} entry
 * @returns {string}
 */
export function normalizePathForComparison(entry) {
  try {
    return realpathSync(entry);
  } catch {
    return resolve(entry);
  }
}

/**
 * @param {string} targetDir
 * @param {string} pathEnv
 * @param {(entry: string) => string} [normalize]
 * @returns {boolean}
 */
export function isDirectoryOnPath(targetDir, pathEnv, normalize = normalizePathForComparison) {
  const normalizedTarget = normalize(targetDir);
  for (const entry of parsePathEntries(pathEnv)) {
    if (normalize(entry) === normalizedTarget) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} output
 * @returns {string | null}
 */
export function parseGlobalBinDirFromPnpmError(output) {
  const match = output.match(GLOBAL_BIN_NOT_IN_PATH_PATTERN);
  return match?.[1] ?? null;
}

/**
 * @param {typeof defaultSpawnSync} [spawnSyncFn]
 * @returns {string}
 */
export function getPnpmGlobalBinDir(spawnSyncFn = defaultSpawnSync) {
  const result = spawnSyncFn("pnpm", ["bin", "-g"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const stdout = (result.stdout ?? "").trim();
  if (result.status === 0 && stdout) {
    return stdout;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const parsedFromError = parseGlobalBinDirFromPnpmError(output);
  if (parsedFromError) {
    return parsedFromError;
  }

  const pnpmHome = process.env.PNPM_HOME;
  if (pnpmHome) {
    return join(pnpmHome, "bin");
  }

  if (result.status !== 0) {
    throw new Error(output ? `pnpm bin -g failed: ${output}` : "pnpm bin -g failed");
  }
  throw new Error("pnpm bin -g returned an empty path");
}

/**
 * @param {string} globalBinDir
 * @returns {string}
 */
export function formatGlobalBinNotOnPathRemediation(globalBinDir) {
  if (process.platform === "win32") {
    return [
      `The configured global bin directory is not in PATH:`,
      `  ${globalBinDir}`,
      "",
      `Add it to your shell configuration:`,
      `  set PATH=%PATH%;${globalBinDir}`,
      "",
      `Then restart your shell and rerun: pnpm run setup`,
    ].join("\n");
  }

  const instructions = [
    `The configured global bin directory is not in PATH:`,
    `  ${globalBinDir}`,
    "",
    `Add it to your shell configuration. Choose one:`,
    "",
    `## zsh`,
    `Add to ~/.zshrc:`,
    `  export PATH="${globalBinDir}:$PATH"`,
    "",
    `## bash`,
    `Add to ~/.bashrc or ~/.bash_profile:`,
    `  export PATH="${globalBinDir}:$PATH"`,
    "",
    `## fish`,
    `Run in fish:`,
    `  set -Ua fish_user_paths ${globalBinDir}`,
    "",
    `After updating your shell configuration, restart your shell and rerun:`,
    `  pnpm run setup`,
  ];

  return instructions.join("\n");
}

/**
 * @param {{
 *   spawnSyncFn?: typeof defaultSpawnSync;
 *   pathEnv?: string;
 *   normalize?: (entry: string) => string;
 * }} [options]
 * @returns {{ ok: true; globalBinDir: string } | { ok: false; globalBinDir: string; message: string }}
 */
export function assertPnpmGlobalBinOnPath(options = {}) {
  const {
    spawnSyncFn = defaultSpawnSync,
    pathEnv = process.env.PATH ?? "",
    normalize = normalizePathForComparison,
  } = options;
  const globalBinDir = getPnpmGlobalBinDir(spawnSyncFn);
  if (isDirectoryOnPath(globalBinDir, pathEnv, normalize)) {
    return { ok: true, globalBinDir };
  }
  return {
    ok: false,
    globalBinDir,
    message: formatGlobalBinNotOnPathRemediation(globalBinDir),
  };
}

/**
 * Get the platform-specific path for a global executable under the pnpm global bin directory.
 * @param {string} globalBinDir
 * @param {string} executableName - name without platform-specific extension (e.g., "okv", "okf-vault")
 * @returns {string}
 */
export function getExecutablePath(globalBinDir, executableName) {
  if (process.platform === "win32") {
    return join(globalBinDir, `${executableName}.cmd`);
  }
  return join(globalBinDir, executableName);
}

/** Spawn args for `pnpm link --global` from the package root (pnpm 11+ requires a directory). */
export const PNPM_GLOBAL_LINK_ARGS = ["link", "--global", "."];

/**
 * Render Unix launcher content for executing a compiled entry point with forwarded arguments.
 * @param {string} entryPoint - absolute path to compiled entry point (e.g., `/path/to/dist/main.js`)
 * @returns {string} Unix launcher script content with shebang and exec invocation
 */
export function renderUnixLauncherContent(entryPoint) {
  const nodePath = process.execPath;
  return `#!/bin/sh
exec "${nodePath}" "${entryPoint}" "$@"
`;
}

/**
 * Render Windows `.cmd` launcher content for executing a compiled entry point with forwarded arguments.
 * @param {string} entryPoint - absolute path to compiled entry point (e.g., `C:\\path\\to\\dist\\main.js`)
 * @returns {string} Windows batch script content
 */
export function renderWindowsCmdLauncherContent(entryPoint) {
  return `@echo off
node.exe "${entryPoint}" %*
`;
}

/**
 * Check if launcher content matches the expected managed launcher shape.
 * Returns true only if the content exactly matches the expected output from this session's renderer.
 * @param {string} content - existing launcher file content to validate
 * @param {string} entryPoint - expected entry point path
 * @returns {boolean} true if content matches expected managed launcher
 */
export function isManagedLauncherContent(content, entryPoint) {
  if (process.platform === "win32") {
    const expected = renderWindowsCmdLauncherContent(entryPoint);
    return content === expected;
  }
  const expected = renderUnixLauncherContent(entryPoint);
  return content === expected;
}
