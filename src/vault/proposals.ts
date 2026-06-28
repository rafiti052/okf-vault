import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import { NOTE_CONTRACT_VERSION } from "./constants.js";
import { checkVaultInitialization, extractLinkTargets, resolveLinkTarget } from "./graph.js";
import {
  buildValidationReport,
  isVaultRelativePath,
  type ValidationIssue,
  type ValidationReport,
} from "./validation.js";

export const PROPOSAL_SCHEMA_VERSION = "okf-vault-proposal/1.0.0" as const;
export const PROPOSAL_VALIDATION_REPORT_SCHEMA_VERSION =
  "okf-vault-proposal-validation/1.0.0" as const;

export const MISSING_CLAIM_IDS_CODE = "MISSING_CLAIM_IDS" as const;
export const AUTO_APPLICATION_PROHIBITED_CODE = "AUTO_APPLICATION_PROHIBITED" as const;
export const INVALID_AFFECTED_PATH_CODE = "INVALID_AFFECTED_PATH" as const;
export const UNRESOLVABLE_LINK_TARGET_CODE = "UNRESOLVABLE_LINK_TARGET" as const;
export const PROPOSAL_SCHEMA_INVALID_CODE = "PROPOSAL_SCHEMA_INVALID" as const;

const MANAGED_PROPOSAL_PREFIXES = ["notes/", "topics/"] as const;

const AUTO_APPLICATION_PATTERNS = [
  /\bauto[-_]?apply\b/i,
  /\bauto[-_]?merge\b/i,
  /\bsilent\s+merge\b/i,
  /\bautomatically\s+merge\b/i,
  /\bwithout\s+(curator\s+)?review\b/i,
  /"auto_apply"\s*:\s*true/i,
  /"autoApply"\s*:\s*true/i,
] as const;

export interface CurationProposal {
  schema_version: typeof PROPOSAL_SCHEMA_VERSION;
  proposal_id: string;
  type: "topic" | "link" | "duplicate" | "contradiction";
  affected_paths: string[];
  claim_ids?: string[];
  rationale: string;
  confidence: "low" | "medium" | "high";
  suggested_changes?: string;
  disposition: "pending" | "accepted" | "rejected" | "resolved";
  curator_comment?: string;
}

export interface ProposalValidationResult {
  report: ValidationReport;
  valid_proposal_ids: string[];
  invalid_proposal_ids: string[];
}

const proposalSchemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/proposal.schema.json",
);

let proposalValidator: ValidateFunction | undefined;

function getProposalValidator(): ValidateFunction {
  if (proposalValidator === undefined) {
    const Ajv2020 = Ajv2020Import as unknown as new (options?: object) => {
      compile: (schema: object) => ValidateFunction;
    };
    const addFormats = addFormatsImport as unknown as (ajv: InstanceType<typeof Ajv2020>) => void;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(proposalSchemaPath, "utf8")) as object;
    proposalValidator = ajv.compile(schema);
  }
  return proposalValidator;
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  const entry: ValidationIssue = { code, message };
  const safePath = path !== undefined && isVaultRelativePath(path) ? path : undefined;
  if (safePath !== undefined) {
    entry.path = safePath;
  }
  return entry;
}

function isManagedProposalPath(relativePath: string): boolean {
  return MANAGED_PROPOSAL_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function pathExistsInVault(vaultRoot: string, relativePath: string): boolean {
  return fs.existsSync(join(vaultRoot, relativePath));
}

function formatSchemaErrors(errors: ErrorObject[] | null | undefined): string {
  return (
    errors?.map((error) => error.message ?? "invalid").join("; ") ??
    "Proposal schema validation failed"
  );
}

function validateProposalSchema(proposal: Record<string, unknown>): ValidationIssue[] {
  const validate = getProposalValidator();
  const proposalId = typeof proposal.proposal_id === "string" ? proposal.proposal_id : "unknown";
  const affectedPath =
    Array.isArray(proposal.affected_paths) &&
    typeof proposal.affected_paths[0] === "string" &&
    isVaultRelativePath(proposal.affected_paths[0])
      ? proposal.affected_paths[0]
      : undefined;
  const valid = validate(proposal);
  if (valid) {
    return [];
  }
  return [
    issue(
      PROPOSAL_SCHEMA_INVALID_CODE,
      `Proposal '${proposalId}' failed schema validation: ${formatSchemaErrors(validate.errors)}`,
      affectedPath,
    ),
  ];
}

function validateClaimIdRequirements(proposal: CurationProposal): ValidationIssue[] {
  if (proposal.type !== "duplicate" && proposal.type !== "contradiction") {
    return [];
  }

  const claimIds = proposal.claim_ids;
  if (!Array.isArray(claimIds) || claimIds.length === 0) {
    return [
      issue(
        MISSING_CLAIM_IDS_CODE,
        `Proposal '${proposal.proposal_id}' of type '${proposal.type}' must cite at least one claim id.`,
        proposal.affected_paths[0],
      ),
    ];
  }

  return [];
}

function validateAutoApplicationPolicy(proposal: CurationProposal): ValidationIssue[] {
  const suggested = proposal.suggested_changes ?? "";
  for (const pattern of AUTO_APPLICATION_PATTERNS) {
    if (pattern.test(suggested)) {
      return [
        issue(
          AUTO_APPLICATION_PROHIBITED_CODE,
          `Proposal '${proposal.proposal_id}' must not include auto-application or silent merge instructions.`,
          proposal.affected_paths[0],
        ),
      ];
    }
  }
  return [];
}

function validateAffectedPaths(vaultRoot: string, proposal: CurationProposal): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const affectedPath of proposal.affected_paths) {
    if (!isVaultRelativePath(affectedPath)) {
      issues.push(
        issue(
          INVALID_AFFECTED_PATH_CODE,
          `Proposal '${proposal.proposal_id}' targets unsafe path '${affectedPath}'.`,
          affectedPath,
        ),
      );
      continue;
    }

    if (!isManagedProposalPath(affectedPath)) {
      issues.push(
        issue(
          INVALID_AFFECTED_PATH_CODE,
          `Proposal '${proposal.proposal_id}' path '${affectedPath}' is outside managed notes/topics paths.`,
          affectedPath,
        ),
      );
      continue;
    }

    if (!pathExistsInVault(vaultRoot, affectedPath)) {
      issues.push(
        issue(
          INVALID_AFFECTED_PATH_CODE,
          `Proposal '${proposal.proposal_id}' targets missing path '${affectedPath}'.`,
          affectedPath,
        ),
      );
    }
  }

  return issues;
}

function validateSuggestedLinkTargets(
  vaultRoot: string,
  proposal: CurationProposal,
): ValidationIssue[] {
  if (proposal.type !== "link" && proposal.type !== "topic") {
    return [];
  }

  const suggested = proposal.suggested_changes;
  if (typeof suggested !== "string" || suggested.trim().length === 0) {
    return [];
  }

  const sourcePath = proposal.affected_paths[0];
  if (sourcePath === undefined) {
    return [];
  }

  const issues: ValidationIssue[] = [];
  for (const rawTarget of extractLinkTargets(suggested)) {
    const resolved = resolveLinkTarget(sourcePath, rawTarget);
    if (resolved === null) {
      continue;
    }
    if (!pathExistsInVault(vaultRoot, resolved)) {
      issues.push(
        issue(
          UNRESOLVABLE_LINK_TARGET_CODE,
          `Proposal '${proposal.proposal_id}' suggested link '${resolved}' does not resolve to an existing note or topic target.`,
          resolved,
        ),
      );
    }
  }

  return issues;
}

export function validateSingleProposal(
  vaultRoot: string,
  proposal: CurationProposal,
): ValidationIssue[] {
  return [
    ...validateProposalSchema(proposal as unknown as Record<string, unknown>),
    ...validateClaimIdRequirements(proposal),
    ...validateAutoApplicationPolicy(proposal),
    ...validateAffectedPaths(vaultRoot, proposal),
    ...validateSuggestedLinkTargets(vaultRoot, proposal),
  ];
}

export function parseProposalBatch(raw: unknown): CurationProposal[] {
  if (Array.isArray(raw)) {
    return raw as CurationProposal[];
  }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const proposals = (raw as { proposals?: unknown }).proposals;
    if (Array.isArray(proposals)) {
      return proposals as CurationProposal[];
    }
  }
  throw new Error("Proposal batch must be an array or an object with a proposals array.");
}

export function validateProposalBatch(
  vaultRoot: string,
  proposals: CurationProposal[],
): ProposalValidationResult {
  const initIssues = checkVaultInitialization(resolve(vaultRoot));
  if (initIssues.length > 0) {
    const report = buildValidationReport(NOTE_CONTRACT_VERSION, initIssues);
    return {
      report,
      valid_proposal_ids: [],
      invalid_proposal_ids: [],
    };
  }

  const issues: ValidationIssue[] = [];
  const validProposalIds: string[] = [];
  const invalidProposalIds: string[] = [];

  for (const proposal of proposals) {
    const proposalIssues = validateSingleProposal(vaultRoot, proposal);
    if (proposalIssues.length === 0) {
      validProposalIds.push(proposal.proposal_id);
    } else {
      invalidProposalIds.push(proposal.proposal_id);
      issues.push(...proposalIssues);
    }
  }

  validProposalIds.sort((left, right) => left.localeCompare(right));
  invalidProposalIds.sort((left, right) => left.localeCompare(right));

  const report = buildValidationReport(NOTE_CONTRACT_VERSION, issues);

  return {
    report,
    valid_proposal_ids: validProposalIds,
    invalid_proposal_ids: invalidProposalIds,
  };
}

export function handleValidateProposals(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  const proposalsPath = args[1];

  if (vaultRoot === undefined || proposalsPath === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "validate-proposals",
        "USAGE_MISSING_ARGS",
        "Usage: validate-proposals <vault-root> <proposals-json-path>",
      ),
      diagnostic: "Missing required arguments for validate-proposals.",
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(resolve(proposalsPath), "utf8")) as unknown;
    const proposals = parseProposalBatch(raw);
    const result = validateProposalBatch(vaultRoot, proposals);
    const initFailed = result.report.issues.some((entry) => entry.code === "VAULT_NOT_INITIALIZED");
    if (initFailed) {
      return {
        exitCode: ExitCode.VALIDATION,
        result: failure("validate-proposals", "VAULT_NOT_INITIALIZED", result.report.summary, {
          ...result.report,
          valid_proposal_ids: result.valid_proposal_ids,
          invalid_proposal_ids: result.invalid_proposal_ids,
        }),
        diagnostic: result.report.summary,
      };
    }

    const exitCode = result.report.status === "pass" ? ExitCode.SUCCESS : ExitCode.VALIDATION;
    return {
      exitCode,
      result: success("validate-proposals", {
        ...result.report,
        schema_version: PROPOSAL_VALIDATION_REPORT_SCHEMA_VERSION,
        valid_proposal_ids: result.valid_proposal_ids,
        invalid_proposal_ids: result.invalid_proposal_ids,
      }),
      ...(exitCode === ExitCode.VALIDATION ? { diagnostic: result.report.summary } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Proposal validation failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("validate-proposals", "VALIDATE_PROPOSALS_FAILED", message),
      diagnostic: message,
    };
  }
}
