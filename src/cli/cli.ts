import { handleDossier } from "../vault/dossier.js";
import { handleDoctor } from "../vault/doctor.js";
import { handleValidateGraph } from "../vault/graph.js";
import { handleInit, handleInspect } from "../vault/manifest.js";
import { handleValidateProposals } from "../vault/proposals.js";
import { handleValidate } from "../vault/quality-gate.js";
import { handleCommit, handleRecover } from "../vault/transaction.js";
import { handleUninstall } from "../vault/uninstall.js";
import { handleValidateStaged } from "../vault/validation.js";
import { handleVisualize } from "../vault/visualizer.js";
import { type OutputMode, resolveOutputMode } from "./output-mode.js";
import { presentHuman } from "./present.js";

/** Stable process exit classes for the okf-vault helper. */
export const ExitCode = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  VALIDATION: 3,
  CONFLICT: 4,
  TRANSACTION: 5,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export type ResultStatus = "ok" | "error";

export interface CliSuccess<T = Record<string, unknown>> {
  status: "ok";
  command: string;
  data: T;
}

export interface CliError {
  status: "error";
  command: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type CliResult<T = Record<string, unknown>> = CliSuccess<T> | CliError;

export const PACKAGE_VERSION = "okv/0.1.0";

/** Reserved subcommands registered by later vault modules. */
export const RESERVED_COMMANDS = [
  "init",
  "inspect",
  "validate-staged",
  "commit",
  "dossier",
  "validate-proposals",
  "validate-graph",
  "validate",
  "visualize",
  "recover",
  "uninstall",
  "doctor",
] as const;

export type ReservedCommand = (typeof RESERVED_COMMANDS)[number];

export function isReservedCommand(value: string): value is ReservedCommand {
  return (RESERVED_COMMANDS as readonly string[]).includes(value);
}

export function writeJsonStdout(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function writeDoctorJsonStdout(result: CliResult): boolean {
  if (result.status !== "ok" || result.command !== "doctor") {
    return false;
  }
  const report = result.data.report;
  if (typeof report !== "object" || report === null || Array.isArray(report)) {
    return false;
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return true;
}

export function writeDiagnostic(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function success<T extends Record<string, unknown>>(
  command: string,
  data: T,
): CliSuccess<T> {
  return { status: "ok", command, data };
}

export function failure(
  command: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CliError {
  const error: CliError = { status: "error", command, code, message };
  if (details !== undefined) {
    error.details = details;
  }
  return error;
}

export interface ParsedArgs {
  command?: string;
  outputModeFlag?: OutputMode;
  showHelp: boolean;
  showVersion: boolean;
  positional: string[];
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  let outputModeFlag: OutputMode | undefined;
  let showHelp = false;
  let showVersion = false;

  for (const arg of argv) {
    if (arg === "--json") {
      outputModeFlag = "json";
      continue;
    }
    if (arg === "--human") {
      if (outputModeFlag !== "json") {
        outputModeFlag = "human";
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-V") {
      showVersion = true;
      continue;
    }
    positional.push(arg);
  }

  const command = positional[0];
  return {
    ...(command !== undefined ? { command } : {}),
    ...(outputModeFlag !== undefined ? { outputModeFlag } : {}),
    showHelp,
    showVersion,
    positional,
  };
}

export function helpText(): string {
  const otherCommands = RESERVED_COMMANDS.filter((name) => name !== "init")
    .map((name) => `  ${name}`)
    .join("\n");
  return [
    "okv — Open Knowledge Vault deterministic helper",
    "",
    "Usage:",
    "  okv [--help] [--version] <command> [args...]",
    "",
    "Commands:",
    "  init [vault-root]  From repo root: create ./knowledge/ and install skill adapters.",
    "                     With vault-root: initialize vault only (no adapters).",
    otherCommands,
    "",
    "Global flags:",
    "  -h, --help       Show help",
    "  -V, --version    Show version",
    "  --json           Emit machine-readable JSON",
    "  --human          Emit human-readable text",
  ].join("\n");
}

export interface DispatchOutcome {
  exitCode: ExitCodeValue;
  result?: CliResult;
  diagnostic?: string;
}

export function dispatch(parsed: ParsedArgs): DispatchOutcome {
  if (parsed.showVersion) {
    return {
      exitCode: ExitCode.SUCCESS,
      result: success("version", { version: PACKAGE_VERSION }),
    };
  }

  if (parsed.showHelp || parsed.command === undefined) {
    const missingCommand = parsed.command === undefined && !parsed.showHelp;
    const outcome: DispatchOutcome = {
      exitCode: missingCommand ? ExitCode.USAGE : ExitCode.SUCCESS,
      result: missingCommand
        ? failure("usage", "USAGE_MISSING_COMMAND", "A command is required.")
        : success("help", { text: helpText() }),
    };
    if (missingCommand) {
      outcome.diagnostic = "Missing command.";
    }
    return outcome;
  }

  if (!isReservedCommand(parsed.command)) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        parsed.command,
        "USAGE_UNKNOWN_COMMAND",
        `Unknown command: ${parsed.command}`,
        { reserved_commands: [...RESERVED_COMMANDS] },
      ),
      diagnostic: `Unknown command: ${parsed.command}`,
    };
  }

  if (parsed.command === "init") {
    return handleInit(parsed.positional.slice(1));
  }

  if (parsed.command === "inspect") {
    return handleInspect(parsed.positional.slice(1));
  }

  if (parsed.command === "validate-staged") {
    return handleValidateStaged(parsed.positional.slice(1));
  }

  if (parsed.command === "validate-graph") {
    return handleValidateGraph(parsed.positional.slice(1));
  }

  if (parsed.command === "commit") {
    return handleCommit(parsed.positional.slice(1));
  }

  if (parsed.command === "recover") {
    return handleRecover(parsed.positional.slice(1));
  }

  if (parsed.command === "dossier") {
    return handleDossier(parsed.positional.slice(1));
  }

  if (parsed.command === "validate-proposals") {
    return handleValidateProposals(parsed.positional.slice(1));
  }

  if (parsed.command === "validate") {
    return handleValidate(parsed.positional.slice(1));
  }

  if (parsed.command === "visualize") {
    return handleVisualize(parsed.positional.slice(1));
  }

  if (parsed.command === "uninstall") {
    return handleUninstall(parsed.positional.slice(1));
  }

  if (parsed.command === "doctor") {
    return handleDoctor(parsed.positional.slice(1), parsed.outputModeFlag);
  }

  return {
    exitCode: ExitCode.VALIDATION,
    result: failure(
      parsed.command,
      "NOT_IMPLEMENTED",
      `Command '${parsed.command}' is reserved but not yet implemented.`,
    ),
    diagnostic: `Handler not registered for ${parsed.command}`,
  };
}

export function run(argv: string[]): ExitCodeValue {
  const parsed = parseArgs(argv);
  const mode = resolveOutputMode({
    argv,
    env: process.env,
    stdoutIsTTY: process.stdout.isTTY === true,
    ...(parsed.outputModeFlag !== undefined ? { outputModeFlag: parsed.outputModeFlag } : {}),
  });
  const outcome = dispatch(parsed);

  if (outcome.diagnostic !== undefined) {
    writeDiagnostic(outcome.diagnostic);
  }

  if (outcome.result !== undefined) {
    if (mode === "json") {
      if (!writeDoctorJsonStdout(outcome.result)) {
        writeJsonStdout(outcome.result);
      }
    } else {
      // TODO(task 11): Document that human --help/--version intentionally render text;
      // --json preserves the historical JSON envelopes for agent callers.
      presentHuman(outcome, {
        mode,
        env: process.env,
        stdoutIsTTY: process.stdout.isTTY === true,
      });
    }
  }

  return outcome.exitCode;
}
