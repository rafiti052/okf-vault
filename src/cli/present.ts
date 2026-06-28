import boxen from "boxen";
import Table from "cli-table3";
import pc from "picocolors";
import { type CliError, type CliResult, type DispatchOutcome, type ExitCodeValue } from "./cli.js";
import type { OutputMode } from "./output-mode.js";

export interface PresentOptions {
  mode: OutputMode;
  noColor?: boolean;
  forceColor?: boolean;
  stdoutIsTTY?: boolean;
  env?: NodeJS.ProcessEnv;
}

interface PresenterContext {
  colors: ReturnType<typeof pc.createColors>;
  colorEnabled: boolean;
  symbols: {
    ok: string;
    fail: string;
    next: string;
    dash: string;
  };
  ascii: boolean;
}

type JsonRecord = Record<string, unknown>;

const EXIT_SUCCESS = 0;
const EXIT_UNEXPECTED = 1;
const EXIT_USAGE = 2;
const EXIT_VALIDATION = 3;
const EXIT_CONFLICT = 4;
const EXIT_TRANSACTION = 5;

const SUCCESS_NEXT_BY_COMMAND: Record<string, string> = {
  init: "run validate to confirm the vault is ready.",
  inspect: "continue the ingest workflow based on the source outcome.",
  "validate-staged": "commit this source if staged validation passed.",
  commit: "continue to the next explicit source.",
  dossier: "review dossiers and prepare curator proposals.",
  "validate-proposals": "present valid proposals to the curator for disposition.",
  "validate-graph": "continue; graph integrity checks passed.",
  validate: "continue; the vault passed the quality gate.",
  visualize: "review the generated graph visualization.",
  recover: "retry the interrupted transaction or rerun validate.",
  uninstall: "verify no managed artifacts remain.",
  doctor: "review any warnings or failures; rerun doctor after repairs.",
  help: "run a command with --human for an interactive summary or --json for agent output.",
  version: "run okv --help to see available commands.",
  retrieve: "review results and refine your query if needed.",
};

const NEXT_BY_EXIT_CODE: Record<ExitCodeValue, string> = {
  [EXIT_SUCCESS]: "continue to the next phase.",
  [EXIT_UNEXPECTED]: "stop, inspect stderr, fix the environment, then retry once.",
  [EXIT_USAGE]: "fix the command arguments, then retry.",
  [EXIT_VALIDATION]: "fix the reported validation issues, then retry or skip with a reason.",
  [EXIT_CONFLICT]: "resolve the manifest or managed-path conflict, then retry.",
  [EXIT_TRANSACTION]: "run recover before retrying the transaction.",
};

const NEXT_BY_ERROR_CODE: Record<string, string> = {
  USAGE_MISSING_COMMAND: "choose a command from help, then retry.",
  USAGE_UNKNOWN_COMMAND: "check the command name with --help, then retry.",
  USAGE_MISSING_ARGS: "add the missing required arguments, then retry.",
  USAGE_INVALID_KIND: "use one of: local, google_drive, granola.",
  VALIDATION_FAILED: "fix validation issues, then rerun the command.",
  STAGED_VALIDATION_FAILED: "fix staged note output, then rerun validate-staged.",
  SOURCE_CHANGED_CONFLICT: "ask the curator whether to retry, skip, or abort this source.",
  SOURCE_ALREADY_PROCESSED: "skip this source or inspect the manifest before retrying.",
  MANAGED_FILE_CONFLICT: "review the managed file conflict before rerunning init.",
  MANAGED_PATH_CONFLICT: "restore or commit managed-path changes before retrying.",
  MANIFEST_REVISION_MISMATCH: "reload the manifest revision, then retry.",
  UNRESOLVED_JOURNAL: "run recover before continuing.",
  VAULT_LOCKED: "wait for the active run or recover a stale lock.",
  VAULT_NOT_INITIALIZED: "run init before this command.",
};

function hasText(value: string | undefined): boolean {
  return value !== undefined && value.length > 0 && value !== "0";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataRecord(result: CliResult | undefined): JsonRecord {
  return result?.status === "ok" && isRecord(result.data) ? result.data : {};
}

function displayName(value: string): string {
  return value.replace(/_/gu, " ");
}

function createContext(options: PresentOptions): PresenterContext {
  const env = options.env ?? process.env;
  const noColor = options.noColor === true || env.NO_COLOR !== undefined;
  const forceColor = options.forceColor === true || hasText(env.FORCE_COLOR);
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY === true;
  const colorEnabled = noColor ? false : forceColor || stdoutIsTTY;
  const ascii = env.TERM === "dumb";

  return {
    colors: pc.createColors(colorEnabled),
    colorEnabled,
    ascii,
    symbols: {
      ok: ascii ? "ok" : "✓",
      fail: ascii ? "x" : "✗",
      next: ascii ? "->" : "→",
      dash: ascii ? "-" : "—",
    },
  };
}

function statusGlyph(outcome: DispatchOutcome, context: PresenterContext): string {
  if (outcome.result?.status === "error" || outcome.exitCode !== EXIT_SUCCESS) {
    return context.symbols.fail;
  }
  return context.symbols.ok;
}

function colorStatus(value: string, status: unknown, context: PresenterContext): string {
  if (status === "pass" || status === "ok" || status === true) {
    return context.colors.green(value);
  }
  if (status === "fail" || status === "error" || status === false) {
    return context.colors.red(value);
  }
  return context.colors.yellow(value);
}

function writeLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function renderHeader(outcome: DispatchOutcome, context: PresenterContext): string {
  const command = outcome.result?.command ?? "error";
  const failed = outcome.result?.status === "error" || outcome.exitCode !== EXIT_SUCCESS;
  const glyph = statusGlyph(outcome, context);
  const text = failed
    ? context.colors.red(`${glyph} ${command}`)
    : context.colors.green(`${glyph} ${command}`);

  return boxen(text, {
    padding: { left: 1, right: 1 },
    borderStyle: context.ascii ? "classic" : "round",
    ...(context.colorEnabled ? { borderColor: failed ? "red" : "green" } : {}),
  });
}

function normalizeCell(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "-";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function createTable(head: string[], context: PresenterContext): Table.Table {
  return new Table({
    head,
    wordWrap: true,
    style: {
      head: context.colorEnabled ? ["cyan"] : [],
      border: context.colorEnabled ? ["gray"] : [],
    },
    ...(context.ascii
      ? {
          chars: {
            top: "-",
            "top-mid": "+",
            "top-left": "+",
            "top-right": "+",
            bottom: "-",
            "bottom-mid": "+",
            "bottom-left": "+",
            "bottom-right": "+",
            left: "|",
            "left-mid": "+",
            mid: "-",
            "mid-mid": "+",
            right: "|",
            "right-mid": "+",
            middle: "|",
          },
        }
      : {}),
  });
}

function stringifyValue(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "0 items";
    }
    if (value.every((entry) => typeof entry === "string")) {
      return value.join(", ");
    }
    return `${value.length} item(s)`;
  }
  if (isRecord(value)) {
    return JSON.stringify(value);
  }
  return normalizeCell(value);
}

function keyValueSummary(data: JsonRecord, context: PresenterContext): string {
  const entries = Object.entries(data);
  if (entries.length === 0) {
    return "No additional details.";
  }

  const table = createTable(["field", "value"], context);
  for (const [key, value] of entries) {
    table.push([displayName(key), stringifyValue(value)]);
  }
  return table.toString();
}

function issueCount(report: JsonRecord): number {
  const issues = report.issues;
  return Array.isArray(issues) ? issues.length : 0;
}

function reportStatus(report: JsonRecord): string {
  const status = report.status;
  if (typeof status === "string") {
    return status;
  }
  return issueCount(report) === 0 ? "pass" : "fail";
}

function reportDetail(report: JsonRecord): string {
  if (typeof report.summary === "string") {
    return report.summary;
  }
  const count = issueCount(report);
  return count === 0 ? "No issues." : `${count} issue(s).`;
}

function addReportRows(
  table: Table.Table,
  name: string,
  report: JsonRecord,
  context: PresenterContext,
): void {
  const status = reportStatus(report);
  const glyph = status === "pass" ? context.symbols.ok : context.symbols.fail;
  table.push([
    displayName(name),
    colorStatus(`${glyph} ${status}`, status, context),
    reportDetail(report),
  ]);

  const issues = report.issues;
  if (Array.isArray(issues)) {
    for (const issue of issues.slice(0, 8)) {
      if (!isRecord(issue)) {
        continue;
      }
      const code = typeof issue.code === "string" ? issue.code : "issue";
      const path = typeof issue.path === "string" ? `${issue.path}: ` : "";
      const message = typeof issue.message === "string" ? issue.message : JSON.stringify(issue);
      table.push([`  ${code}`, context.symbols.fail, `${path}${message}`]);
    }
    if (issues.length > 8) {
      table.push(["  more", context.symbols.fail, `${issues.length - 8} additional issue(s).`]);
    }
  }
}

function validationSummary(result: CliResult, context: PresenterContext): string {
  const data = dataRecord(result);
  const table = createTable(["check", "status", "detail"], context);

  const checks = data.checks;
  if (isRecord(checks)) {
    for (const [name, report] of Object.entries(checks)) {
      if (isRecord(report)) {
        addReportRows(table, name, report, context);
      }
    }
  } else if (isRecord(data.report)) {
    addReportRows(table, result.command, data.report, context);
  } else {
    addReportRows(table, result.command, data, context);
  }

  return table.length > 0 ? table.toString() : keyValueSummary(data, context);
}

function transactionSummary(data: JsonRecord, context: PresenterContext): string {
  const fields = [
    "run_id",
    "source_key",
    "note_path",
    "commit",
    "revision",
    "staged_paths",
    "recovered",
    "restored_paths",
  ];
  const narrowed: JsonRecord = {};
  for (const field of fields) {
    if (field in data) {
      narrowed[field] = data[field];
    }
  }
  return keyValueSummary(Object.keys(narrowed).length > 0 ? narrowed : data, context);
}

function artifactLabel(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!isRecord(value)) {
    return normalizeCell(value);
  }
  const label = value.label ?? value.path ?? value.name ?? value.target ?? value.kind;
  return normalizeCell(label);
}

function artifactDetail(value: unknown): string {
  if (!isRecord(value)) {
    return "-";
  }
  const detail = value.reason ?? value.error ?? value.status ?? value.kind ?? value.path;
  return normalizeCell(detail);
}

function uninstallSummary(data: JsonRecord, context: PresenterContext): string {
  const table = createTable(["artifact", "removed", "skipped", "detail"], context);
  const removed = Array.isArray(data.removed) ? data.removed : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  const errors = Array.isArray(data.errors) ? data.errors : [];

  for (const item of removed) {
    table.push([artifactLabel(item), context.symbols.ok, "-", artifactDetail(item)]);
  }
  for (const item of skipped) {
    table.push([artifactLabel(item), "-", context.symbols.ok, artifactDetail(item)]);
  }
  for (const item of errors) {
    table.push([artifactLabel(item), context.symbols.fail, "-", artifactDetail(item)]);
  }

  return table.length > 0 ? table.toString() : keyValueSummary(data, context);
}

function initSummary(data: JsonRecord, context: PresenterContext): string {
  const summaryFields: JsonRecord = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "linked" || key === "skipped" || key === "removed" || key === "legacy_removed") {
      continue;
    }
    summaryFields[key] = value;
  }

  const sections = [keyValueSummary(summaryFields, context)];
  const removed = Array.isArray(data.legacy_removed)
    ? data.legacy_removed
    : Array.isArray(data.removed)
      ? data.removed
      : [];
  const table = createTable(["removed legacy path"], context);
  if (removed.length === 0) {
    table.push(["none"]);
  } else {
    for (const path of removed) {
      table.push([normalizeCell(path)]);
    }
  }
  sections.push(table.toString());
  return sections.join("\n\n");
}

function helpSummary(data: JsonRecord): string {
  return typeof data.text === "string" ? data.text : "No help text available.";
}

function versionSummary(data: JsonRecord): string {
  return `version: ${normalizeCell(data.version)}`;
}

function errorSummary(error: CliError, context: PresenterContext): string {
  const lines = [context.colors.red(error.message)];
  if (error.code.length > 0) {
    lines.push(`code: ${error.code}`);
  }
  if (error.details !== undefined) {
    lines.push(keyValueSummary(error.details, context));
  }
  return lines.join("\n");
}

function retrieveSummary(data: JsonRecord, context: PresenterContext): string {
  // Eval mode: data contains query_results array and metrics object.
  if (Array.isArray(data.query_results)) {
    const sections: string[] = [];

    // Aggregate metrics summary.
    const metrics = isRecord(data.metrics) ? data.metrics : {};
    const hitRate =
      typeof metrics.hit_rate === "number"
        ? `${Math.round((metrics.hit_rate as number) * 100)}%`
        : "N/A";
    const metricsTable = createTable(["metric", "value"], context);
    metricsTable.push(["total queries", normalizeCell(metrics.total_queries)]);
    metricsTable.push(["hit rate", hitRate]);
    metricsTable.push(["high confidence", normalizeCell(metrics.high_confidence_count)]);
    metricsTable.push(["medium confidence", normalizeCell(metrics.medium_confidence_count)]);
    metricsTable.push(["low confidence", normalizeCell(metrics.low_confidence_count)]);
    metricsTable.push(["coverage gaps", normalizeCell(metrics.coverage_gap_count)]);
    metricsTable.push(["median duration (ms)", normalizeCell(metrics.median_duration_ms)]);
    sections.push(metricsTable.toString());

    // Per-query outcomes table.
    const queryResults = data.query_results as unknown[];
    if (queryResults.length > 0) {
      const perQueryTable = createTable(["query", "hit", "confidence", "gap"], context);
      for (const qr of queryResults) {
        if (!isRecord(qr)) continue;
        const hitGlyph = qr.hit === true ? context.symbols.ok : context.symbols.fail;
        const gapGlyph = qr.coverage_gap === true ? context.symbols.fail : context.symbols.ok;
        const shortQuery = typeof qr.query === "string" ? qr.query.slice(0, 48) : "";
        perQueryTable.push([shortQuery, hitGlyph, normalizeCell(qr.confidence), gapGlyph]);
      }
      sections.push(perQueryTable.toString());
    }

    return sections.join("\n\n");
  }

  // Query mode: coverage gap.
  if (data.coverage_gap === true) {
    const lines = ["No strong topic match found for this query."];
    if (Array.isArray(data.broadening_hints) && data.broadening_hints.length > 0) {
      lines.push("Broadening hints:");
      for (const hint of data.broadening_hints as unknown[]) {
        if (!isRecord(hint)) continue;
        const suggestion =
          typeof hint.suggested_query === "string" ? ` → try: "${hint.suggested_query}"` : "";
        lines.push(`  ${normalizeCell(hint.reason)}${suggestion}`);
      }
    }
    return lines.join("\n");
  }

  // Query mode: normal result.
  const sections: string[] = [];
  const topResult = Array.isArray(data.results) && data.results.length > 0
    ? data.results[0]
    : undefined;

  if (isRecord(topResult)) {
    const summaryTable = createTable(["field", "value"], context);
    summaryTable.push(["topic", normalizeCell(topResult.title)]);
    summaryTable.push(["confidence", normalizeCell(data.confidence)]);
    summaryTable.push(["linked notes", normalizeCell(
      Array.isArray(topResult.linked_notes) ? topResult.linked_notes.length : 0,
    )]);
    if (typeof topResult.excerpt === "string" && topResult.excerpt.length > 0) {
      summaryTable.push(["excerpt", topResult.excerpt.slice(0, 120)]);
    }
    sections.push(summaryTable.toString());
  } else {
    sections.push(keyValueSummary(data, context));
  }

  // Broadening hints when confidence is not high.
  if (
    data.confidence !== "high" &&
    Array.isArray(data.broadening_hints) &&
    data.broadening_hints.length > 0
  ) {
    const hints = data.broadening_hints as unknown[];
    const hintsTable = createTable(["hint", "suggested query"], context);
    for (const hint of hints) {
      if (!isRecord(hint)) continue;
      hintsTable.push([
        normalizeCell(hint.reason),
        normalizeCell(hint.suggested_query ?? ""),
      ]);
    }
    sections.push(hintsTable.toString());
  }

  return sections.join("\n\n");
}

function bodyFor(outcome: DispatchOutcome, context: PresenterContext): string {
  const result = outcome.result;
  if (result === undefined) {
    return "No structured result was returned.";
  }

  if (result.status === "error") {
    return errorSummary(result, context);
  }

  const data = dataRecord(result);
  if (result.command === "help") {
    return helpSummary(data);
  }
  if (result.command === "version") {
    return versionSummary(data);
  }
  if (result.command.startsWith("validate") || result.command === "doctor") {
    return validationSummary(result, context);
  }
  if (result.command === "commit" || result.command === "recover") {
    return transactionSummary(data, context);
  }
  if (result.command === "uninstall") {
    return uninstallSummary(data, context);
  }
  if (result.command === "init") {
    return initSummary(data, context);
  }
  if (result.command === "inspect") {
    return keyValueSummary(data, context);
  }
  if (result.command === "retrieve") {
    return retrieveSummary(data, context);
  }
  return keyValueSummary(data, context);
}

function nextStep(outcome: DispatchOutcome): string {
  const result = outcome.result;
  if (result?.status === "error") {
    return (
      NEXT_BY_ERROR_CODE[result.code] ??
      NEXT_BY_EXIT_CODE[outcome.exitCode] ??
      "stop, inspect the error, then retry."
    );
  }
  if (outcome.exitCode !== EXIT_SUCCESS) {
    return NEXT_BY_EXIT_CODE[outcome.exitCode] ?? "stop, inspect the result, then retry.";
  }
  if (result?.command !== undefined && SUCCESS_NEXT_BY_COMMAND[result.command] !== undefined) {
    return SUCCESS_NEXT_BY_COMMAND[result.command] ?? "continue when ready.";
  }
  return NEXT_BY_EXIT_CODE[outcome.exitCode] ?? "continue when ready.";
}

export function presentHuman(outcome: DispatchOutcome, options: PresentOptions): void {
  const context = createContext(options);
  const sections = [
    renderHeader(outcome, context),
    bodyFor(outcome, context),
    `${context.symbols.next} next: ${nextStep(outcome)}`,
  ];
  writeLine(sections.filter((section) => section.trim().length > 0).join("\n\n"));
}
