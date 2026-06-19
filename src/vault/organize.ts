import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { type NoteDossier } from "./dossier.js";
import { checkVaultInitialization } from "./graph.js";
import { loadManifest } from "./manifest.js";
import { type CurationProposal } from "./proposals.js";
import { readTransactionJournal } from "./transaction.js";
import { parseNoteContent } from "./validation.js";

export const ORGANIZE_MODE_INITIAL = "initial" as const;
export const ORGANIZE_MODE_INCREMENTAL = "incremental" as const;

export type OrganizeMode = typeof ORGANIZE_MODE_INITIAL | typeof ORGANIZE_MODE_INCREMENTAL;

export const ORGANIZE_BLOCKED_UNRESOLVED_JOURNAL_CODE =
  "ORGANIZE_BLOCKED_UNRESOLVED_JOURNAL" as const;
export const ORGANIZE_BLOCKED_PENDING_SOURCES_CODE = "ORGANIZE_BLOCKED_PENDING_SOURCES" as const;
export const PROPOSAL_PATH_MOVE_PROHIBITED_CODE = "PROPOSAL_PATH_MOVE_PROHIBITED" as const;
export const PROPOSAL_SILENT_DUPLICATE_MERGE_CODE = "PROPOSAL_SILENT_DUPLICATE_MERGE" as const;

const PATH_MOVE_PATTERNS = [
  /\bmove\s+(?:note|file|path)\b/i,
  /\brename\s+(?:note|file|to)\b/i,
  /\bnotes\/[^\s]+\s*(?:->|→)\s*notes\//i,
  /\brelocate\b/i,
  /\bchange\s+note_path\b/i,
] as const;

const SILENT_MERGE_PATTERNS = [
  /\bmerge\s+into\b/i,
  /\bdelete\s+duplicate\b/i,
  /\bremove\s+duplicate\s+note\b/i,
  /\bconsolidate\s+notes\b/i,
] as const;

const TERM_SPLIT_PATTERN = /[^a-z0-9]+/u;

export interface OrganizePreflightInput {
  vaultRoot: string;
  mode: OrganizeMode;
  /** Source keys from the ingest run that must be committed or skipped before initial organize. */
  ingestBatchSourceKeys?: readonly string[];
}

export interface OrganizePreflightResult {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface IncrementalOrganizeScopeInput {
  dossiers: readonly NoteDossier[];
  newSourceKeys: readonly string[];
  topicMapPaths: readonly string[];
}

export interface IncrementalOrganizeScopeResult {
  /** Stable sorted dossier paths selected for incremental analysis. */
  selected_dossier_paths: string[];
  /** Always-included Maps-of-Content paths. */
  topic_map_paths: string[];
  /** Newly committed source keys included in scope. */
  new_source_keys: string[];
  /** Existing notes selected only through normalized-term overlap. */
  overlap_selected_paths: string[];
}

export function normalizeOrganizeTerm(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function extractOrganizeTerms(dossier: NoteDossier): string[] {
  const terms = new Set<string>();

  for (const hint of dossier.topic_hints) {
    const normalized = normalizeOrganizeTerm(hint);
    if (normalized.length > 0) {
      terms.add(normalized);
    }
  }

  for (const token of normalizeOrganizeTerm(dossier.title).split(TERM_SPLIT_PATTERN)) {
    if (token.length >= 3) {
      terms.add(token);
    }
  }

  for (const claim of dossier.claims) {
    for (const token of normalizeOrganizeTerm(claim.text).split(TERM_SPLIT_PATTERN)) {
      if (token.length >= 3) {
        terms.add(token);
      }
    }
  }

  return [...terms].sort((left, right) => left.localeCompare(right));
}

export function countTermOverlap(left: NoteDossier, right: NoteDossier): number {
  const rightTerms = new Set(extractOrganizeTerms(right));
  return extractOrganizeTerms(left).filter((term) => rightTerms.has(term)).length;
}

export function listTopicMapPaths(vaultRoot: string): string[] {
  const topicsDir = join(resolve(vaultRoot), "topics");
  if (!fs.existsSync(topicsDir)) {
    return [];
  }

  const paths: string[] = [];
  for (const entry of fs.readdirSync(topicsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
      continue;
    }

    const relativePath = join("topics", entry.name).split("\\").join("/");
    const content = fs.readFileSync(join(topicsDir, entry.name), "utf8");
    const parsed = parseNoteContent(relativePath, content);
    if (Array.isArray(parsed)) {
      continue;
    }

    if (parsed.frontmatter.type === "Topic Map") {
      paths.push(relativePath);
    }
  }

  return paths.sort((left, right) => left.localeCompare(right));
}

export function selectIncrementalOrganizeScope(
  input: IncrementalOrganizeScopeInput,
): IncrementalOrganizeScopeResult {
  const newSourceKeySet = new Set(input.newSourceKeys);
  const topicMapPaths = [...input.topicMapPaths].sort((left, right) => left.localeCompare(right));

  const newDossiers = input.dossiers
    .filter((dossier) => newSourceKeySet.has(dossier.source.source_key))
    .sort((left, right) => left.path.localeCompare(right.path));

  const newPaths = new Set(newDossiers.map((dossier) => dossier.path));
  const overlapSelected: string[] = [];

  for (const existing of input.dossiers) {
    if (newPaths.has(existing.path)) {
      continue;
    }

    const overlaps = newDossiers.some((candidate) => countTermOverlap(existing, candidate) >= 1);
    if (overlaps) {
      overlapSelected.push(existing.path);
    }
  }

  overlapSelected.sort((left, right) => left.localeCompare(right));

  const selectedPaths = [
    ...new Set([
      ...newDossiers.map((dossier) => dossier.path),
      ...overlapSelected,
      ...topicMapPaths,
    ]),
  ].sort((left, right) => left.localeCompare(right));

  return {
    selected_dossier_paths: selectedPaths,
    topic_map_paths: topicMapPaths,
    new_source_keys: [...input.newSourceKeys].sort((left, right) => left.localeCompare(right)),
    overlap_selected_paths: overlapSelected,
  };
}

export function checkOrganizePreflight(input: OrganizePreflightInput): OrganizePreflightResult {
  const root = resolve(input.vaultRoot);
  const initIssues = checkVaultInitialization(root);
  if (initIssues.length > 0) {
    return {
      ok: false,
      code: initIssues[0]?.code ?? "VAULT_NOT_INITIALIZED",
      message: initIssues[0]?.message ?? "Vault is not initialized.",
    };
  }

  const journal = readTransactionJournal(root);
  if (journal !== undefined) {
    return {
      ok: false,
      code: ORGANIZE_BLOCKED_UNRESOLVED_JOURNAL_CODE,
      message: `Organize blocked: unresolved transaction journal for run '${journal.run_id}'. Run recover before organizing.`,
    };
  }

  if (input.mode === ORGANIZE_MODE_INITIAL && input.ingestBatchSourceKeys !== undefined) {
    const manifest = loadManifest(root);
    const manifestByKey = new Map(manifest.sources.map((record) => [record.source_key, record]));
    const pending = input.ingestBatchSourceKeys.filter((sourceKey) => {
      const record = manifestByKey.get(sourceKey);
      return record === undefined || (record.status !== "committed" && record.status !== "skipped");
    });

    if (pending.length > 0) {
      return {
        ok: false,
        code: ORGANIZE_BLOCKED_PENDING_SOURCES_CODE,
        message: `Organize blocked: ingest batch has pending sources (${pending.join(", ")}).`,
      };
    }
  }

  return { ok: true };
}

export function proposalImpliesPathMove(proposal: CurationProposal): boolean {
  const haystack = `${proposal.rationale}\n${proposal.suggested_changes ?? ""}`;
  return PATH_MOVE_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function proposalImpliesSilentDuplicateMerge(proposal: CurationProposal): boolean {
  if (proposal.type !== "duplicate") {
    return false;
  }
  const haystack = `${proposal.rationale}\n${proposal.suggested_changes ?? ""}`;
  return SILENT_MERGE_PATTERNS.some((pattern) => pattern.test(haystack));
}

export function filterProposalsToScope(
  proposals: readonly CurationProposal[],
  scopePaths: readonly string[],
): CurationProposal[] {
  const scope = new Set(scopePaths);
  return proposals.filter((proposal) => proposal.affected_paths.every((path) => scope.has(path)));
}

export function proposalsTargetPathsOutsideScope(
  proposals: readonly CurationProposal[],
  scopePaths: readonly string[],
): string[] {
  const scope = new Set(scopePaths);
  const outside = new Set<string>();

  for (const proposal of proposals) {
    for (const path of proposal.affected_paths) {
      if (!scope.has(path)) {
        outside.add(path);
      }
    }
  }

  return [...outside].sort((left, right) => left.localeCompare(right));
}
