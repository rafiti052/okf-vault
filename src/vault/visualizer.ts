import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli.js";

export const VISUALIZER_CONFIG_RELATIVE_PATH = ".okf-vault/visualizer.json" as const;
export const VISUALIZER_SCHEMA_VERSION = "okf-vault-visualizer-config/1.0.0" as const;

export interface VisualizerConfig {
  schema_version: typeof VISUALIZER_SCHEMA_VERSION;
  command: string[];
  output_dir?: string;
}

export interface VisualizerResult {
  invoked: boolean;
  exit_code: number;
  output_dir?: string;
  stdout: string;
  stderr: string;
}

export function visualizerConfigPath(vaultRoot: string): string {
  return join(resolve(vaultRoot), VISUALIZER_CONFIG_RELATIVE_PATH);
}

export function loadVisualizerConfig(vaultRoot: string): VisualizerConfig {
  const configPath = visualizerConfigPath(vaultRoot);
  if (!fs.existsSync(configPath)) {
    throw new Error(`Visualizer config not found at ${VISUALIZER_CONFIG_RELATIVE_PATH}`);
  }

  const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as VisualizerConfig;
  if (raw.schema_version !== VISUALIZER_SCHEMA_VERSION) {
    throw new Error(`Unsupported visualizer schema_version '${String(raw.schema_version)}'`);
  }
  if (!Array.isArray(raw.command) || raw.command.length === 0) {
    throw new Error("Visualizer config requires a non-empty command argument array.");
  }

  return raw;
}

function snapshotManagedFiles(vaultRoot: string): Map<string, string> {
  const root = resolve(vaultRoot);
  const snapshot = new Map<string, string>();

  function walk(relativeDir: string): void {
    const absoluteDir = join(root, relativeDir);
    if (!fs.existsSync(absoluteDir)) {
      return;
    }
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = `${relativeDir}/${entry.name}`.replace(/^\.\//u, "");
      if (entry.isDirectory()) {
        if (relativePath.includes(".okf-vault/tmp")) {
          continue;
        }
        walk(relativePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      if (relativePath.startsWith(".okf-vault/tmp/")) {
        continue;
      }
      snapshot.set(relativePath, fs.readFileSync(join(root, relativePath), "utf8"));
    }
  }

  walk(".");
  return snapshot;
}

function managedFilesUnchanged(
  vaultRoot: string,
  before: Map<string, string>,
): { unchanged: boolean; changed_paths: string[] } {
  const after = snapshotManagedFiles(vaultRoot);
  const changed: string[] = [];

  for (const [path, content] of before) {
    if (after.get(path) !== content) {
      changed.push(path);
    }
  }

  for (const path of after.keys()) {
    if (!before.has(path)) {
      changed.push(path);
    }
  }

  return { unchanged: changed.length === 0, changed_paths: changed.sort() };
}

export function invokeVisualizer(vaultRoot: string, config?: VisualizerConfig): VisualizerResult {
  const resolvedConfig = config ?? loadVisualizerConfig(vaultRoot);
  const root = resolve(vaultRoot);
  const argv = [...resolvedConfig.command, root];
  const before = snapshotManagedFiles(vaultRoot);

  const child = spawnSync(argv[0] ?? "", argv.slice(1), {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  const integrity = managedFilesUnchanged(vaultRoot, before);
  if (!integrity.unchanged) {
    throw new Error(
      `Visualizer mutated managed vault files: ${integrity.changed_paths.join(", ")}`,
    );
  }

  return {
    invoked: true,
    exit_code: child.status ?? 1,
    ...(resolvedConfig.output_dir !== undefined ? { output_dir: resolvedConfig.output_dir } : {}),
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
  };
}

export function handleVisualize(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("visualize", "USAGE_MISSING_ARGS", "Usage: visualize <vault-root>"),
      diagnostic: "Missing required argument for visualize.",
    };
  }

  try {
    const result = invokeVisualizer(vaultRoot);
    const exitCode = result.exit_code === 0 ? ExitCode.SUCCESS : ExitCode.VALIDATION;

    return {
      exitCode,
      result: success("visualize", { ...result }),
      ...(exitCode === ExitCode.VALIDATION
        ? { diagnostic: result.stderr || "Visualizer failed." }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Visualizer invocation failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("visualize", "VISUALIZE_FAILED", message),
      diagnostic: message,
    };
  }
}
