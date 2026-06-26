import * as fs from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { DiagnosticCheckResult, DoctorReport } from "./diagnostics.js";

const LEGACY_GLOBAL_BINARY_NAMES = ["okf-vault", "okv-cli"] as const;
const OKV_VALIDATE_STAGED_COMMAND = "okv validate-staged";
const OKV_VALIDATE_STAGED_BLOCK = [
  "",
  "# OKV vault validation",
  "if command -v okv >/dev/null 2>&1; then",
  "  okv validate-staged",
  "fi",
  "",
].join("\n");

export type Prompter = (question: string) => boolean | Promise<boolean>;

export interface RepairAction {
  code: string;
  status: "applied" | "skipped" | "error";
  message: string;
  path?: string;
}

export interface RepairResult {
  applied: RepairAction[];
  skipped: RepairAction[];
  errors: RepairAction[];
}

export interface RepairOptions {
  prompter?: Prompter;
  input?: Readable;
  output?: Writable;
  stdout?: { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
}

function emptyRepairResult(): RepairResult {
  return { applied: [], skipped: [], errors: [] };
}

function record(result: RepairResult, action: RepairAction): void {
  if (action.status === "applied") {
    result.applied.push(action);
    return;
  }
  if (action.status === "skipped") {
    result.skipped.push(action);
    return;
  }
  result.errors.push(action);
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

function isInteractiveRun(options: RepairOptions): boolean {
  const stdout = options.stdout ?? process.stdout;
  const env = options.env ?? process.env;
  return stdout.isTTY === true && !isCi(env);
}

function isYes(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === "" || normalized === "y" || normalized === "yes";
}

export function createReadlinePrompter(options: RepairOptions = {}): Prompter {
  return async (question: string): Promise<boolean> => {
    const rl = createInterface({
      input: options.input ?? process.stdin,
      output: options.output ?? process.stdout,
    });
    try {
      return isYes(await rl.question(question));
    } finally {
      rl.close();
    }
  };
}

async function confirm(question: string, options: RepairOptions): Promise<boolean> {
  if (options.prompter !== undefined) {
    return options.prompter(question);
  }
  if (!isInteractiveRun(options)) {
    return false;
  }
  return createReadlinePrompter(options)(question);
}

function existsOrSymlink(path: string): boolean {
  try {
    fs.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function unique(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}

function discoverLegacyConflictPaths(envPath: string): string[] {
  const paths: string[] = [];
  for (const dir of envPath.split(delimiter).filter(Boolean)) {
    for (const name of LEGACY_GLOBAL_BINARY_NAMES) {
      const candidate = join(dir, name);
      if (existsOrSymlink(candidate)) {
        paths.push(candidate);
      }
    }
  }
  return unique(paths);
}

export async function repairLegacyGlobalConflicts(
  options: RepairOptions & {
    envPath?: string;
    paths?: string[];
  } = {},
): Promise<RepairResult> {
  const result = emptyRepairResult();
  const legacyPaths =
    options.paths !== undefined
      ? unique(options.paths)
      : discoverLegacyConflictPaths(options.envPath ?? process.env.PATH ?? "");

  for (const path of legacyPaths) {
    if (!existsOrSymlink(path)) {
      record(result, {
        code: "PATH_LEGACY_CONFLICT",
        status: "skipped",
        message: "Legacy binary is not present",
        path,
      });
      continue;
    }

    const approved = await confirm(`Remove legacy OKV binary at ${path}? [Y/n] `, options);
    if (!approved) {
      record(result, {
        code: "PATH_LEGACY_CONFLICT",
        status: "skipped",
        message: "Legacy binary removal declined",
        path,
      });
      continue;
    }

    try {
      fs.rmSync(path, { recursive: true, force: true });
      record(result, {
        code: "PATH_LEGACY_CONFLICT",
        status: "applied",
        message: "Legacy binary removed",
        path,
      });
    } catch (error) {
      record(result, {
        code: "PATH_LEGACY_CONFLICT",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
        path,
      });
    }
  }

  return result;
}

export async function repairCursorRules(
  projectRoot: string,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const result = emptyRepairResult();
  const root = resolve(projectRoot);
  const sourceTemplate = join(root, ".agents", "skills", "okf-vault", "templates", "okv.mdc");
  const destRule = join(root, ".cursor", "rules", "okv.mdc");

  if (!fs.existsSync(sourceTemplate)) {
    record(result, {
      code: "RULES_TEMPLATE_MISSING",
      status: "error",
      message: "System rule template is missing",
      path: sourceTemplate,
    });
    return result;
  }

  const approved = await confirm(`Restore Cursor rule template at ${destRule}? [Y/n] `, options);
  if (!approved) {
    record(result, {
      code: "RULES_REPAIR_DECLINED",
      status: "skipped",
      message: "Cursor rule template repair declined",
      path: destRule,
    });
    return result;
  }

  try {
    fs.mkdirSync(dirname(destRule), { recursive: true });
    fs.copyFileSync(sourceTemplate, destRule);
    record(result, {
      code: "RULES_REPAIRED",
      status: "applied",
      message: "Cursor rule template restored",
      path: destRule,
    });
  } catch (error) {
    record(result, {
      code: "RULES_REPAIR_FAILED",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      path: destRule,
    });
  }

  return result;
}

function hookPath(projectRoot: string): string {
  const root = resolve(projectRoot);
  const huskyPath = join(root, ".husky", "pre-commit");
  if (fs.existsSync(huskyPath)) {
    return huskyPath;
  }
  return join(root, ".git", "hooks", "pre-commit");
}

function appendValidator(content: string): string {
  const prefix = content.endsWith("\n") ? content.slice(0, -1) : content;
  return `${prefix}${OKV_VALIDATE_STAGED_BLOCK}`;
}

export async function repairPreCommitHook(
  projectRoot: string,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const result = emptyRepairResult();
  const path = hookPath(projectRoot);
  const exists = fs.existsSync(path);
  const approved = await confirm(
    `Install okv validate-staged in pre-commit hook at ${path}? [Y/n] `,
    options,
  );

  if (!approved) {
    record(result, {
      code: "HOOKS_REPAIR_DECLINED",
      status: "skipped",
      message: "Pre-commit hook repair declined",
      path,
    });
    return result;
  }

  try {
    if (exists) {
      const content = fs.readFileSync(path, "utf8");
      if (content.includes(OKV_VALIDATE_STAGED_COMMAND)) {
        record(result, {
          code: "HOOKS_ALREADY_CHAINED",
          status: "skipped",
          message: "Pre-commit hook already runs okv validate-staged",
          path,
        });
        return result;
      }
      fs.writeFileSync(path, appendValidator(content), "utf8");
      record(result, {
        code: "HOOKS_CHAINED",
        status: "applied",
        message: "okv validate-staged appended to existing pre-commit hook",
        path,
      });
      return result;
    }

    fs.mkdirSync(dirname(path), { recursive: true });
    fs.writeFileSync(path, `#!/bin/sh${OKV_VALIDATE_STAGED_BLOCK}`, "utf8");
    fs.chmodSync(path, 0o755);
    record(result, {
      code: "HOOKS_CREATED",
      status: "applied",
      message: "Pre-commit hook created with okv validate-staged",
      path,
    });
  } catch (error) {
    record(result, {
      code: "HOOKS_REPAIR_FAILED",
      status: "error",
      message: error instanceof Error ? error.message : String(error),
      path,
    });
  }

  return result;
}

function mergeResults(target: RepairResult, source: RepairResult): void {
  target.applied.push(...source.applied);
  target.skipped.push(...source.skipped);
  target.errors.push(...source.errors);
}

function issuePaths(report: DoctorReport, code: string): string[] {
  const paths: string[] = [];
  for (const check of Object.values(report.checks)) {
    for (const issue of check.issues) {
      if (issue.code === code && issue.path !== undefined) {
        paths.push(issue.path);
      }
    }
  }
  return unique(paths);
}

function hasIssue(report: DoctorReport, codes: string[]): boolean {
  return Object.values(report.checks).some((check) =>
    check.issues.some((issue: DiagnosticCheckResult) => codes.includes(issue.code)),
  );
}

export async function runDoctorRepairWizard(
  projectRoot: string,
  report: DoctorReport,
  options: RepairOptions = {},
): Promise<RepairResult> {
  const result = emptyRepairResult();
  const legacyPaths = issuePaths(report, "PATH_LEGACY_CONFLICT");
  if (legacyPaths.length > 0) {
    mergeResults(result, await repairLegacyGlobalConflicts({ ...options, paths: legacyPaths }));
  }
  if (hasIssue(report, ["RULES_MISSING", "RULES_OUTDATED"])) {
    mergeResults(result, await repairCursorRules(projectRoot, options));
  }
  if (hasIssue(report, ["HOOKS_LACKS_OKV", "HOOKS_MISSING"])) {
    mergeResults(result, await repairPreCommitHook(projectRoot, options));
  }
  return result;
}
