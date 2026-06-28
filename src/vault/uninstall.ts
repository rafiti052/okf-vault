import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, type DispatchOutcome, failure, success } from "../cli/cli.js";

type ManagedArtifactKind = "symlink" | "file-copy" | "global-bin";

export interface ManagedArtifact {
  kind: ManagedArtifactKind;
  label: string;
  path?: string;
  name?: string;
  target?: string;
  template?: string;
  legacy?: boolean;
  tombstone?: boolean;
}

export interface UninstallReportItem {
  label: string;
  kind: ManagedArtifactKind | "metadata";
  path?: string;
  name?: string;
  reason?: string;
  error?: string;
  dry_run?: boolean;
  legacy?: boolean;
}

export interface UninstallResult {
  [key: string]: unknown;
  project_root: string;
  dry_run: boolean;
  purge: boolean;
  removed: UninstallReportItem[];
  skipped: UninstallReportItem[];
  errors: UninstallReportItem[];
}

interface ParsedUninstallArgs {
  dryRun: boolean;
  purge: boolean;
  yes: boolean;
}

interface FsLike {
  lstatSync: typeof fs.lstatSync;
  rmSync: typeof fs.rmSync;
  readdirSync: typeof fs.readdirSync;
}

interface StdinLike {
  isTTY?: boolean;
}

interface StdoutLike {
  isTTY?: boolean;
}

interface CommandRunner {
  (command: string, args: string[]): { status: number | null; stdout?: string; stderr?: string };
}

interface UninstallOptions {
  projectRoot?: string;
  manifestProvider?: (projectRoot: string) => {
    managed: ManagedArtifact[];
    legacy: ManagedArtifact[];
  };
  legacySweeper?: (projectRoot: string) => { removed: string[] };
  fsImpl?: FsLike;
  globalBinDir?: string;
  globalBinDirs?: string[];
  stdin?: StdinLike;
  stdout?: StdoutLike;
  env?: NodeJS.ProcessEnv;
  commandRunner?: CommandRunner;
  readConfirmation?: () => string;
}

const METADATA_DIR = ".okf-vault";
const LEGACY_GLOBAL_BINARY_NAMES = ["okf-vault", "okv-cli"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isManagedArtifact(value: unknown): value is ManagedArtifact {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.kind === "symlink" || value.kind === "file-copy" || value.kind === "global-bin") &&
    typeof value.label === "string"
  );
}

function isManagedArtifactArray(value: unknown): value is ManagedArtifact[] {
  return Array.isArray(value) && value.every(isManagedArtifact);
}

function resolveInstallRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    if (fs.existsSync(join(dir, "scripts", "managed-artifacts.mjs"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not resolve okf-vault install root");
}

function defaultManifestProvider(projectRoot: string): {
  managed: ManagedArtifact[];
  legacy: ManagedArtifact[];
} {
  const installRoot = resolveInstallRoot();
  const script = [
    "import { listManagedArtifacts, listLegacyArtifacts } from './scripts/managed-artifacts.mjs';",
    "const root = process.argv[1];",
    "process.stdout.write(JSON.stringify({",
    "managed: listManagedArtifacts(root),",
    "legacy: listLegacyArtifacts(root),",
    "}));",
  ].join("");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, projectRoot], {
    cwd: installRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
    throw new Error(`Failed to load managed artifacts: ${detail}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  if (
    !isRecord(parsed) ||
    !isManagedArtifactArray(parsed.managed) ||
    !isManagedArtifactArray(parsed.legacy)
  ) {
    throw new Error("Managed artifact manifest returned an invalid payload");
  }
  return {
    managed: parsed.managed,
    legacy: parsed.legacy,
  };
}

function defaultLegacySweeper(projectRoot: string): { removed: string[] } {
  const installRoot = resolveInstallRoot();
  const script = [
    "import { sweepLegacyArtifacts } from './scripts/link-runtime-adapters.mjs';",
    "const result = sweepLegacyArtifacts(process.argv[1]);",
    "process.stdout.write(JSON.stringify(result));",
  ].join("");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, projectRoot], {
    cwd: installRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
    throw new Error(`Failed to sweep legacy artifacts: ${detail}`);
  }
  const parsed = JSON.parse(result.stdout) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.removed)) {
    throw new Error("Legacy sweep returned an invalid payload");
  }
  return {
    removed: parsed.removed.filter((entry): entry is string => typeof entry === "string"),
  };
}

function parseUninstallArgs(args: string[]): ParsedUninstallArgs | { error: string } {
  const parsed: ParsedUninstallArgs = { dryRun: false, purge: false, yes: false };
  for (const arg of args) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--purge") {
      parsed.purge = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
      continue;
    }
    return { error: `Unknown uninstall argument: ${arg}` };
  }
  return parsed;
}

function existsOrSymlink(path: string, fsImpl: FsLike): boolean {
  try {
    fsImpl.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function reportFromArtifact(
  artifact: ManagedArtifact,
  extra: Partial<UninstallReportItem> = {},
): UninstallReportItem {
  return {
    label: artifact.label,
    kind: artifact.kind,
    ...(artifact.path !== undefined ? { path: artifact.path } : {}),
    ...(artifact.name !== undefined ? { name: artifact.name } : {}),
    ...(artifact.legacy === true ? { legacy: true } : {}),
    ...extra,
  };
}

function globalArtifacts(managed: ManagedArtifact[], legacy: ManagedArtifact[]): ManagedArtifact[] {
  const artifacts = new Map<string, ManagedArtifact>();
  for (const artifact of [...legacy, ...managed]) {
    if (artifact.kind === "global-bin" && artifact.name !== undefined) {
      artifacts.set(artifact.name, artifact);
    }
  }
  for (const name of LEGACY_GLOBAL_BINARY_NAMES) {
    if (!artifacts.has(name)) {
      artifacts.set(name, {
        kind: "global-bin",
        name,
        label: `Legacy ${name} global binary`,
        legacy: true,
      });
    }
  }
  return [...artifacts.values()];
}

function metadataPath(projectRoot: string, fsImpl: FsLike): string {
  const knowledgeMetadata = join(projectRoot, "knowledge", METADATA_DIR);
  const rootMetadata = join(projectRoot, METADATA_DIR);
  if (existsOrSymlink(knowledgeMetadata, fsImpl)) {
    return knowledgeMetadata;
  }
  if (existsOrSymlink(join(projectRoot, "knowledge"), fsImpl)) {
    return knowledgeMetadata;
  }
  return rootMetadata;
}

function metadataReport(
  projectRoot: string,
  fsImpl: FsLike,
  extra: Partial<UninstallReportItem> = {},
): UninstallReportItem {
  return {
    label: "OKF vault metadata",
    kind: "metadata",
    path: metadataPath(projectRoot, fsImpl),
    ...extra,
  };
}

function cleanupEmptyCursorCommandDirectory(path: string, fsImpl: FsLike): void {
  if (basename(path) !== "SKILL.md") {
    return;
  }
  const parent = dirname(path);
  try {
    if (fsImpl.readdirSync(parent).length === 0) {
      fsImpl.rmSync(parent, { recursive: true, force: true });
    }
  } catch {
    // Best-effort cleanup only; the removed file is already reported.
  }
}

function defaultCommandRunner(
  command: string,
  args: string[],
): {
  status: number | null;
  stdout?: string;
  stderr?: string;
} {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? undefined,
    stderr: result.stderr ?? undefined,
  };
}

function normalizeDirectory(path: string): string | undefined {
  const trimmed = path.trim();
  return trimmed.length > 0 ? resolve(trimmed) : undefined;
}

function addDirectory(dirs: string[], path: string | undefined): void {
  if (path === undefined) {
    return;
  }
  const normalized = normalizeDirectory(path);
  if (normalized !== undefined && !dirs.includes(normalized)) {
    dirs.push(normalized);
  }
}

function npmBinDirFromPrefix(prefix: string): string | undefined {
  const normalized = normalizeDirectory(prefix);
  if (normalized === undefined) {
    return undefined;
  }
  return process.platform === "win32" ? normalized : join(normalized, "bin");
}

function resolveGlobalBinDirs(options: UninstallOptions): string[] {
  if (options.globalBinDirs !== undefined) {
    const explicitDirs: string[] = [];
    for (const dir of options.globalBinDirs) {
      addDirectory(explicitDirs, dir);
    }
    return explicitDirs;
  }

  const dirs: string[] = [];
  if (options.globalBinDir !== undefined) {
    addDirectory(dirs, options.globalBinDir);
    return dirs;
  }

  const env = options.env ?? process.env;
  if (env.OKV_GLOBAL_BIN_DIR !== undefined) {
    addDirectory(dirs, env.OKV_GLOBAL_BIN_DIR);
    return dirs;
  }

  const run = options.commandRunner ?? defaultCommandRunner;
  for (const args of [
    ["config", "get", "global-bin-dir"],
    ["bin", "-g"],
  ]) {
    const pnpm = run("pnpm", args);
    if (pnpm.status === 0) {
      addDirectory(dirs, pnpm.stdout);
    }
  }

  if (env.PNPM_HOME !== undefined) {
    addDirectory(dirs, env.PNPM_HOME);
  }

  const npm = run("npm", ["config", "get", "prefix", "-g"]);
  if (npm.status === 0) {
    addDirectory(dirs, npmBinDirFromPrefix(npm.stdout ?? ""));
  }

  return dirs;
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

function isInteractiveRun(options: UninstallOptions): boolean {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  return stdout.isTTY === true && !isCi(env);
}

function requiresLegacyConfirmation(artifact: ManagedArtifact): boolean {
  return artifact.legacy === true || artifact.name === "okf-vault" || artifact.name === "okv-cli";
}

function confirmLegacyRemoval(
  options: UninstallOptions,
  artifact: ManagedArtifact,
  path: string,
): boolean {
  if (!isInteractiveRun(options)) {
    return true;
  }
  const answer =
    options.readConfirmation !== undefined
      ? options.readConfirmation()
      : readConfirmationFromStdin(
          `Legacy binary '${artifact.name ?? artifact.label}' found at ${path}. Uninstall global conflict? [Y/n] `,
        );
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

function readConfirmationFromStdin(prompt: string): string {
  process.stderr.write(prompt);
  const buffer = Buffer.alloc(32);
  try {
    const bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "n";
  }
}

function removeLocalArtifact(
  artifact: ManagedArtifact,
  fsImpl: FsLike,
  result: UninstallResult,
): void {
  if (artifact.path === undefined) {
    result.skipped.push(reportFromArtifact(artifact, { reason: "missing path" }));
    return;
  }
  if (!existsOrSymlink(artifact.path, fsImpl)) {
    result.skipped.push(reportFromArtifact(artifact, { reason: "not present" }));
    return;
  }

  try {
    const stat = fsImpl.lstatSync(artifact.path);
    if (artifact.kind === "symlink" && !stat.isSymbolicLink()) {
      result.skipped.push(reportFromArtifact(artifact, { reason: "not a symlink" }));
      return;
    }
    if (artifact.kind === "file-copy" && stat.isDirectory()) {
      result.skipped.push(reportFromArtifact(artifact, { reason: "not a file" }));
      return;
    }
    fsImpl.rmSync(artifact.path, { recursive: true, force: true });
    cleanupEmptyCursorCommandDirectory(artifact.path, fsImpl);
    result.removed.push(reportFromArtifact(artifact));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(reportFromArtifact(artifact, { error: message }));
  }
}

function removeGlobalArtifact(
  artifact: ManagedArtifact,
  globalBinDirs: string[],
  fsImpl: FsLike,
  result: UninstallResult,
  options: UninstallOptions,
): void {
  if (artifact.name === undefined) {
    result.skipped.push(reportFromArtifact(artifact, { reason: "missing binary name" }));
    return;
  }
  if (globalBinDirs.length === 0) {
    result.skipped.push(
      reportFromArtifact(artifact, {
        reason: "global bin directories unavailable; remove from PATH manually if present",
      }),
    );
    return;
  }

  for (const globalBinDir of globalBinDirs) {
    const binPath = join(globalBinDir, artifact.name);
    const report = reportFromArtifact(artifact, { path: binPath });
    if (!existsOrSymlink(binPath, fsImpl)) {
      result.skipped.push({ ...report, reason: "not present" });
      continue;
    }
    if (requiresLegacyConfirmation(artifact) && !confirmLegacyRemoval(options, artifact, binPath)) {
      result.skipped.push({ ...report, reason: "confirmation declined" });
      continue;
    }
    try {
      fsImpl.rmSync(binPath, { recursive: true, force: true });
      result.removed.push(report);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ ...report, error: message });
    }
  }
}

function previewArtifacts(
  artifacts: ManagedArtifact[],
  fsImpl: FsLike,
  globalBinDirs: string[],
  result: UninstallResult,
): void {
  for (const artifact of artifacts) {
    if (artifact.kind === "global-bin") {
      if (artifact.name === undefined || globalBinDirs.length === 0) {
        result.skipped.push(
          reportFromArtifact(artifact, {
            reason: "dry-run: global bin mutation skipped",
            dry_run: true,
          }),
        );
        continue;
      }
      for (const globalBinDir of globalBinDirs) {
        result.skipped.push(
          reportFromArtifact(artifact, {
            path: join(globalBinDir, artifact.name),
            reason: "dry-run: global bin mutation skipped",
            dry_run: true,
          }),
        );
      }
      continue;
    }
    if (artifact.path !== undefined && existsOrSymlink(artifact.path, fsImpl)) {
      result.removed.push(reportFromArtifact(artifact, { dry_run: true }));
    } else {
      result.skipped.push(reportFromArtifact(artifact, { reason: "not present", dry_run: true }));
    }
  }
}

function confirmPurge(options: UninstallOptions, metadataDirectory: string): boolean {
  if (options.readConfirmation !== undefined) {
    return options.readConfirmation().trim().toLowerCase() === "yes";
  }
  process.stderr.write(`Remove OKV metadata at ${metadataDirectory}? Type yes to continue: `);
  const buffer = Buffer.alloc(32);
  try {
    const bytes = fs.readSync(0, buffer, 0, buffer.length, null);
    return buffer.subarray(0, bytes).toString("utf8").trim().toLowerCase() === "yes";
  } catch {
    return false;
  }
}

export function uninstallManagedArtifacts(
  args: string[],
  options: UninstallOptions = {},
): DispatchOutcome {
  const parsed = parseUninstallArgs(args);
  if ("error" in parsed) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("uninstall", "USAGE_UNKNOWN_ARGUMENT", parsed.error, {
        removed: [],
        skipped: [],
        errors: [],
      }),
      diagnostic: parsed.error,
    };
  }

  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const fsImpl = options.fsImpl ?? fs;
  const result: UninstallResult = {
    project_root: projectRoot,
    dry_run: parsed.dryRun,
    purge: parsed.purge,
    removed: [],
    skipped: [],
    errors: [],
  };

  try {
    const manifest = (options.manifestProvider ?? defaultManifestProvider)(projectRoot);
    const previewTargets = [
      ...manifest.legacy.filter((artifact) => artifact.kind !== "global-bin"),
      ...manifest.managed.filter((artifact) => artifact.kind !== "global-bin"),
      ...globalArtifacts(manifest.managed, manifest.legacy),
    ];
    const globalBinDirs = resolveGlobalBinDirs(options);

    if (parsed.dryRun) {
      previewArtifacts(previewTargets, fsImpl, globalBinDirs, result);
      if (parsed.purge) {
        const target = metadataPath(projectRoot, fsImpl);
        if (existsOrSymlink(target, fsImpl)) {
          result.removed.push(metadataReport(projectRoot, fsImpl, { dry_run: true }));
        } else {
          result.skipped.push(
            metadataReport(projectRoot, fsImpl, { reason: "not present", dry_run: true }),
          );
        }
      }
      return { exitCode: ExitCode.SUCCESS, result: success("uninstall", result) };
    }

    const swept = (options.legacySweeper ?? defaultLegacySweeper)(projectRoot);
    for (const removedPath of swept.removed) {
      result.removed.push({
        label: "Legacy managed artifact",
        kind: "symlink",
        path: removedPath,
        legacy: true,
      });
    }

    for (const artifact of manifest.managed.filter((item) => item.kind !== "global-bin")) {
      removeLocalArtifact(artifact, fsImpl, result);
    }

    for (const artifact of globalArtifacts(manifest.managed, manifest.legacy)) {
      removeGlobalArtifact(artifact, globalBinDirs, fsImpl, result, options);
    }

    if (parsed.purge) {
      const targetMetadataPath = metadataPath(projectRoot, fsImpl);
      const stdin = options.stdin ?? process.stdin;
      if (!parsed.yes && stdin.isTTY !== true) {
        result.skipped.push(
          metadataReport(projectRoot, fsImpl, { reason: "requires --yes in non-TTY" }),
        );
        return {
          exitCode: ExitCode.USAGE,
          result: failure(
            "uninstall",
            "PURGE_REQUIRES_CONFIRMATION",
            "--purge requires --yes when stdin is not interactive.",
            result,
          ),
          diagnostic: "--purge requires --yes when stdin is not interactive.",
        };
      }
      if (!parsed.yes && !confirmPurge(options, targetMetadataPath)) {
        result.skipped.push(
          metadataReport(projectRoot, fsImpl, { reason: "confirmation declined" }),
        );
        return { exitCode: ExitCode.CONFLICT, result: success("uninstall", result) };
      }
      if (!existsOrSymlink(targetMetadataPath, fsImpl)) {
        result.skipped.push(metadataReport(projectRoot, fsImpl, { reason: "not present" }));
      } else {
        try {
          fsImpl.rmSync(targetMetadataPath, { recursive: true, force: true });
          result.removed.push(metadataReport(projectRoot, fsImpl));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.errors.push(metadataReport(projectRoot, fsImpl, { error: message }));
        }
      }
    }

    return {
      exitCode: result.errors.length > 0 ? ExitCode.UNEXPECTED : ExitCode.SUCCESS,
      result: success("uninstall", result),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Uninstall failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("uninstall", "UNINSTALL_FAILED", message, result),
      diagnostic: message,
    };
  }
}

export function handleUninstall(args: string[]): DispatchOutcome {
  return uninstallManagedArtifacts(args);
}
