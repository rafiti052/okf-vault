import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import type { OutputMode } from "../cli/output-mode.js";
import { type DoctorReport, runDiagnostics } from "./diagnostics.js";
import { runDoctorRepairWizard } from "./doctor-repair.js";

type DoctorStatus = "pass" | "warn" | "fail";

interface ParsedDoctorArgs {
  outputMode?: OutputMode;
  projectRoot: string;
}

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && value.toLowerCase() !== "false";
}

function aggregateStatus(report: DoctorReport): DoctorStatus {
  const statuses = Object.values(report.checks).map((check) => check.status);
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  return "pass";
}

function issueCount(report: DoctorReport): number {
  return Object.values(report.checks).reduce(
    (count, check) => count + check.issues.filter((issue) => issue.status !== "pass").length,
    0,
  );
}

function parseDoctorArgs(
  args: string[],
  outputMode?: string,
): ParsedDoctorArgs | { error: string } {
  let mode: OutputMode | undefined =
    outputMode === "json" || outputMode === "human" ? outputMode : undefined;
  const positional: string[] = [];

  for (const arg of args) {
    if (arg === "--json") {
      mode = "json";
      continue;
    }
    if (arg === "--human") {
      if (mode !== "json") {
        mode = "human";
      }
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 1) {
    return { error: "doctor accepts at most one project root argument" };
  }

  const projectRoot = positional[0] ?? process.cwd();
  return {
    ...(mode !== undefined ? { outputMode: mode } : {}),
    projectRoot,
  };
}

function shouldOfferInteractiveRepair(mode: OutputMode | undefined, status: DoctorStatus): boolean {
  if (status === "pass" || mode === "json") {
    return false;
  }
  return process.stdout.isTTY === true && !isCi(process.env);
}

export function handleDoctor(args: string[], outputMode?: string): DispatchOutcome {
  const parsed = parseDoctorArgs(args, outputMode);
  if ("error" in parsed) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("doctor", "USAGE_INVALID_ARGS", parsed.error),
      diagnostic: parsed.error,
    };
  }

  const report = runDiagnostics(parsed.projectRoot, process.env.PATH);
  const status = aggregateStatus(report);
  const issues = issueCount(report);
  const repairOffered = shouldOfferInteractiveRepair(parsed.outputMode, status);

  if (repairOffered) {
    setImmediate(() => {
      void runDoctorRepairWizard(parsed.projectRoot, report).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Doctor repair wizard failed: ${message}\n`);
      });
    });
  }

  return {
    exitCode: status === "fail" ? ExitCode.VALIDATION : ExitCode.SUCCESS,
    result: success("doctor", {
      status,
      issues,
      project_root: parsed.projectRoot,
      repair_offered: repairOffered,
      checks: report.checks,
      report,
    }),
  };
}
