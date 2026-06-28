import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import {
  MANAGED_INIT_FILES,
  NOTE_CONTRACT_VERSION,
  NOTES_INDEX_PATH,
  REVIEWS_DIR,
  ROOT_INDEX_PATH,
  TOPICS_INDEX_PATH,
} from "./constants.js";
import { validateVaultGraph } from "./graph.js";
import { loadManifest, validateManifestDiskConsistency } from "./manifest.js";
import { type CurationProposal } from "./proposals.js";
import { readTransactionJournal, readVaultLock } from "./transaction.js";
import {
  buildValidationReport,
  validateCommittedNotes,
  type ValidationIssue,
  type ValidationReport,
} from "./validation.js";

export const QUALITY_GATE_SCHEMA_VERSION = "okf-vault-quality-gate/1.0.0" as const;
export const REVIEW_SCHEMA_VERSION = "okf-vault-review/1.0.0" as const;

export const PENDING_PROPOSAL_DISPOSITION_CODE = "PENDING_PROPOSAL_DISPOSITION" as const;
export const MISSING_GOLD_REVIEW_CODE = "MISSING_GOLD_REVIEW" as const;
export const TRANSACTION_STATE_UNRESOLVED_CODE = "TRANSACTION_STATE_UNRESOLVED" as const;
export const INDEX_NOT_POPULATED_CODE = "INDEX_NOT_POPULATED" as const;

export interface VaultReviewRecord {
  schema_version: typeof REVIEW_SCHEMA_VERSION;
  run_id: string;
  recorded_at: string;
  required_gold_reviews?: string[];
  gold_note_reviews?: Record<string, { status: string; note_paths?: string[] }>;
  proposals?: CurationProposal[];
}

export interface QualityGateCheckReports {
  committed_notes: ValidationReport;
  manifest: ValidationReport;
  graph: ValidationReport;
  transaction_state: ValidationReport;
  curation: ValidationReport;
  gold_reviews: ValidationReport;
}

export interface QualityGateResult {
  schema_version: typeof QUALITY_GATE_SCHEMA_VERSION;
  contract_version: string;
  status: "pass" | "fail";
  quality_gate_passed: boolean;
  summary: string;
  checks: QualityGateCheckReports;
  issues: ValidationIssue[];
}

function gateIssue(code: string, message: string, path?: string): ValidationIssue {
  const entry: ValidationIssue = { code, message };
  if (path !== undefined) {
    entry.path = path;
  }
  return entry;
}

function isIndexPopulated(content: string): boolean {
  const lines = content.split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
      continue;
    }
    if (/^[-*]\s+\S/u.test(trimmed) || /\[[^\]]+\]\([^)]+\)/u.test(trimmed)) {
      return true;
    }
  }
  return false;
}

export function validateIndexPopulation(vaultRoot: string): ValidationIssue[] {
  const root = resolve(vaultRoot);
  const issues: ValidationIssue[] = [];
  const indexPaths = [ROOT_INDEX_PATH, NOTES_INDEX_PATH, TOPICS_INDEX_PATH];

  for (const relativePath of indexPaths) {
    const absolutePath = join(root, relativePath);
    if (!fs.existsSync(absolutePath)) {
      issues.push(
        gateIssue(
          INDEX_NOT_POPULATED_CODE,
          `Required index is missing: ${relativePath}.`,
          relativePath,
        ),
      );
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    const expected = MANAGED_INIT_FILES[relativePath];
    if (expected !== undefined && content === expected && !isIndexPopulated(expected)) {
      issues.push(
        gateIssue(
          INDEX_NOT_POPULATED_CODE,
          `Index '${relativePath}' is not populated with navigation entries.`,
          relativePath,
        ),
      );
      continue;
    }
    if (!isIndexPopulated(content)) {
      issues.push(
        gateIssue(
          INDEX_NOT_POPULATED_CODE,
          `Index '${relativePath}' is not populated with navigation entries.`,
          relativePath,
        ),
      );
    }
  }

  return issues;
}

export function listReviewRecords(vaultRoot: string): VaultReviewRecord[] {
  const reviewsDir = join(resolve(vaultRoot), REVIEWS_DIR);
  if (!fs.existsSync(reviewsDir)) {
    return [];
  }

  const records: VaultReviewRecord[] = [];
  for (const entry of fs.readdirSync(reviewsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const raw = JSON.parse(
      fs.readFileSync(join(reviewsDir, entry.name), "utf8"),
    ) as VaultReviewRecord;
    if (raw.schema_version === REVIEW_SCHEMA_VERSION) {
      records.push(raw);
    }
  }

  return records.sort((left, right) => left.recorded_at.localeCompare(right.recorded_at));
}

export function latestReviewRecord(vaultRoot: string): VaultReviewRecord | undefined {
  const records = listReviewRecords(vaultRoot);
  return records.length > 0 ? records[records.length - 1] : undefined;
}

export function validateProposalDispositions(vaultRoot: string): ValidationIssue[] {
  const review = latestReviewRecord(vaultRoot);
  if (review === undefined || review.proposals === undefined) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  for (const proposal of review.proposals) {
    if (proposal.type !== "duplicate" && proposal.type !== "contradiction") {
      continue;
    }
    if (proposal.disposition === "pending") {
      issues.push(
        gateIssue(
          PENDING_PROPOSAL_DISPOSITION_CODE,
          `Proposal '${proposal.proposal_id}' of type '${proposal.type}' lacks curator disposition.`,
          proposal.affected_paths[0],
        ),
      );
    }
  }

  return issues;
}

export function committedNoteTypes(vaultRoot: string): Set<string> {
  const root = resolve(vaultRoot);
  const manifest = loadManifest(vaultRoot);
  const types = new Set<string>();

  for (const record of manifest.sources) {
    if (record.status !== "committed" || record.note_path === undefined) {
      continue;
    }
    const absolutePath = join(root, record.note_path);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content);
    if (match === null) {
      continue;
    }
    const typeMatch = /^type:\s*(.+)$/mu.exec(match[1] ?? "");
    if (typeMatch !== null) {
      types.add(typeMatch[1]?.trim() ?? "");
    }
  }

  return types;
}

export function validateGoldNoteReviews(vaultRoot: string): ValidationIssue[] {
  const review = latestReviewRecord(vaultRoot);
  const required = review?.required_gold_reviews ?? [];

  if (required.length === 0) {
    return [];
  }

  const recorded = review?.gold_note_reviews ?? {};
  const issues: ValidationIssue[] = [];

  for (const noteType of required) {
    const entry = recorded[noteType];
    if (entry === undefined || entry.status !== "reviewed") {
      issues.push(
        gateIssue(
          MISSING_GOLD_REVIEW_CODE,
          `Required gold-note review for '${noteType}' is not recorded under ${REVIEWS_DIR}/.`,
        ),
      );
    }
  }

  return issues;
}

export function validateTransactionState(vaultRoot: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const journal = readTransactionJournal(vaultRoot);
  if (journal !== undefined) {
    issues.push(
      gateIssue(
        TRANSACTION_STATE_UNRESOLVED_CODE,
        `Unresolved transaction journal for run '${journal.run_id}' remains; run recover before quality gate.`,
      ),
    );
  }

  const lock = readVaultLock(vaultRoot);
  if (lock !== undefined) {
    issues.push(
      gateIssue(
        TRANSACTION_STATE_UNRESOLVED_CODE,
        `Vault lock held by run '${lock.run_id}' remains; run recover before quality gate.`,
      ),
    );
  }

  return issues;
}

function mergeIssues(...groups: ValidationIssue[][]): ValidationIssue[] {
  return groups.flat();
}

export function runQualityGate(vaultRoot: string): QualityGateResult {
  let contractVersion: string = NOTE_CONTRACT_VERSION;

  try {
    contractVersion = loadManifest(vaultRoot).note_contract_version;
  } catch {
    // manifest load failures surface through graph init checks
  }

  const committedIssues = validateCommittedNotes(vaultRoot);
  const manifestIssues = [
    ...validateManifestDiskConsistency(vaultRoot),
    ...validateIndexPopulation(vaultRoot),
  ];
  const graphResult = validateVaultGraph(vaultRoot);
  const transactionIssues = validateTransactionState(vaultRoot);
  const curationIssues = validateProposalDispositions(vaultRoot);
  const goldReviewIssues = validateGoldNoteReviews(vaultRoot);

  const committedReport = buildValidationReport(contractVersion, committedIssues);
  const manifestReport = buildValidationReport(contractVersion, manifestIssues);
  const transactionReport = buildValidationReport(contractVersion, transactionIssues);
  const curationReport = buildValidationReport(contractVersion, curationIssues);
  const goldReviewReport = buildValidationReport(contractVersion, goldReviewIssues);

  const allIssues = mergeIssues(
    committedIssues,
    manifestIssues,
    graphResult.report.issues,
    transactionIssues,
    curationIssues,
    goldReviewIssues,
  );

  const status = allIssues.length === 0 ? "pass" : "fail";
  const summary =
    status === "pass"
      ? "Quality gate passed: all deterministic checks, dispositions, and required reviews are complete."
      : `Quality gate failed with ${allIssues.length} issue(s).`;

  return {
    schema_version: QUALITY_GATE_SCHEMA_VERSION,
    contract_version: contractVersion,
    status,
    quality_gate_passed: status === "pass",
    summary,
    checks: {
      committed_notes: committedReport,
      manifest: manifestReport,
      graph: graphResult.report,
      transaction_state: transactionReport,
      curation: curationReport,
      gold_reviews: goldReviewReport,
    },
    issues: allIssues,
  };
}

export function handleValidate(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("validate", "USAGE_MISSING_ARGS", "Usage: validate <vault-root>"),
      diagnostic: "Missing required argument for validate.",
    };
  }

  try {
    const result = runQualityGate(vaultRoot);
    const exitCode = result.status === "pass" ? ExitCode.SUCCESS : ExitCode.VALIDATION;

    return {
      exitCode,
      result: success("validate", { ...result }),
      ...(exitCode === ExitCode.VALIDATION ? { diagnostic: result.summary } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quality gate validation failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("validate", "VALIDATE_FAILED", message),
      diagnostic: message,
    };
  }
}
