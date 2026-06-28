import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import {
  buildVaultLinkGraph,
  checkVaultInitialization,
  extractLinkTargets,
  resolveLinkTarget,
  type VaultLinkGraph,
} from "./graph.js";
import { loadManifest } from "./manifest.js";
import {
  CREDENTIAL_FIELD_PATTERN,
  extractSection,
  isVaultRelativePath,
  parseNoteContent,
  type ParsedNote,
} from "./validation.js";

/** Dossier set envelope version for organize-pass consumption. */
export const DOSSIER_SET_SCHEMA_VERSION = "okf-vault-dossier-set/1.0.0" as const;
export const DOSSIER_SCHEMA_VERSION = "okf-vault-dossier/1.0.0" as const;

/**
 * Documented per-field bounds (TechSpec Organize/curate pass, ADR-007).
 * Keeps a 50-note corpus within agent context without embeddings.
 */
export const DOSSIER_BOUNDS = {
  maxSummaryChars: 512,
  maxClaimTextChars: 128,
  maxClaimsWithText: 8,
  maxTopicHints: 12,
  maxTopicHintChars: 48,
  maxExistingLinks: 16,
  maxSerializedBytes: 4096,
} as const;

export interface DossierSourceIdentity {
  source_key: string;
  kind: string;
}

export interface DossierClaim {
  id: string;
  text: string;
}

export interface NoteDossier {
  schema_version: typeof DOSSIER_SCHEMA_VERSION;
  path: string;
  title: string;
  summary: string;
  claims: DossierClaim[];
  claim_ids: string[];
  claims_truncated: boolean;
  source: DossierSourceIdentity;
  existing_links: string[];
  topic_hints: string[];
}

export interface DossierSetResult {
  schema_version: typeof DOSSIER_SET_SCHEMA_VERSION;
  contract_version: string;
  dossiers: NoteDossier[];
  count: number;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

function parseClaimsFromFrontmatter(
  frontmatter: Record<string, unknown>,
): Array<{ id: string; text: string }> {
  const claims = frontmatter.claims;
  if (!Array.isArray(claims)) {
    return [];
  }

  const parsed: Array<{ id: string; text: string }> = [];
  for (const entry of claims) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const id = record.id;
    const text = record.text;
    if (typeof id !== "string" || typeof text !== "string") {
      continue;
    }
    parsed.push({ id, text });
  }

  return parsed.sort((left, right) => left.id.localeCompare(right.id));
}

function parseTopicHints(frontmatter: Record<string, unknown>): string[] {
  const tags = frontmatter.tags;
  if (!Array.isArray(tags)) {
    return [];
  }

  const hints: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== "string") {
      continue;
    }
    const trimmed = tag.trim();
    if (trimmed.length === 0) {
      continue;
    }
    hints.push(truncateText(trimmed, DOSSIER_BOUNDS.maxTopicHintChars));
  }

  return [...new Set(hints)]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, DOSSIER_BOUNDS.maxTopicHints);
}

function parseSourceIdentity(frontmatter: Record<string, unknown>): DossierSourceIdentity | null {
  const source = frontmatter.source;
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return null;
  }
  const record = source as Record<string, unknown>;
  const sourceKey = record.source_key;
  const kind = record.kind;
  if (typeof sourceKey !== "string" || typeof kind !== "string") {
    return null;
  }
  return { source_key: sourceKey, kind };
}

function existingLinksForNote(notePath: string, content: string, graph: VaultLinkGraph): string[] {
  const resolved = new Set<string>();
  for (const rawTarget of extractLinkTargets(content)) {
    const target = resolveLinkTarget(notePath, rawTarget);
    if (target !== null) {
      resolved.add(target);
    }
  }

  for (const edge of graph.edges) {
    if (edge.source === notePath) {
      resolved.add(edge.target);
    }
    if (edge.target === notePath) {
      resolved.add(edge.source);
    }
  }

  return [...resolved]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, DOSSIER_BOUNDS.maxExistingLinks);
}

function boundedClaims(rawClaims: Array<{ id: string; text: string }>): {
  claims: DossierClaim[];
  claim_ids: string[];
  claims_truncated: boolean;
} {
  const claimIds = rawClaims
    .map((claim) => claim.id)
    .sort((left, right) => left.localeCompare(right));
  const claimsWithText = rawClaims.slice(0, DOSSIER_BOUNDS.maxClaimsWithText).map((claim) => ({
    id: claim.id,
    text: truncateText(claim.text.trim(), DOSSIER_BOUNDS.maxClaimTextChars),
  }));

  return {
    claims: claimsWithText.sort((left, right) => left.id.localeCompare(right.id)),
    claim_ids: claimIds,
    claims_truncated: rawClaims.length > DOSSIER_BOUNDS.maxClaimsWithText,
  };
}

function shrinkDossierToByteLimit(dossier: NoteDossier): NoteDossier {
  let current = dossier;
  let serialized = JSON.stringify(current);

  if (serialized.length <= DOSSIER_BOUNDS.maxSerializedBytes) {
    return current;
  }

  current = {
    ...current,
    summary: truncateText(current.summary, Math.floor(DOSSIER_BOUNDS.maxSummaryChars / 2)),
    claims: current.claims.map((claim) => ({
      ...claim,
      text: truncateText(claim.text, Math.floor(DOSSIER_BOUNDS.maxClaimTextChars / 2)),
    })),
  };
  serialized = JSON.stringify(current);
  if (serialized.length <= DOSSIER_BOUNDS.maxSerializedBytes) {
    return current;
  }

  return {
    ...current,
    summary: truncateText(current.summary, 128),
    claims: current.claims.map((claim) => ({ id: claim.id, text: claim.id })),
    existing_links: current.existing_links.slice(0, 8),
    topic_hints: current.topic_hints.slice(0, 4),
  };
}

export function buildNoteDossier(note: ParsedNote, graph: VaultLinkGraph): NoteDossier | null {
  const title = note.frontmatter.title;
  if (typeof title !== "string" || title.trim() === "") {
    return null;
  }

  const source = parseSourceIdentity(note.frontmatter);
  if (source === null) {
    return null;
  }

  const summarySection = extractSection(note.body, "# Summary") ?? "";
  const rawClaims = parseClaimsFromFrontmatter(note.frontmatter);
  const { claims, claim_ids, claims_truncated } = boundedClaims(rawClaims);

  const dossier = shrinkDossierToByteLimit({
    schema_version: DOSSIER_SCHEMA_VERSION,
    path: note.relativePath,
    title: title.trim(),
    summary: truncateText(summarySection.trim(), DOSSIER_BOUNDS.maxSummaryChars),
    claims,
    claim_ids,
    claims_truncated,
    source,
    existing_links: existingLinksForNote(note.relativePath, note.body, graph),
    topic_hints: parseTopicHints(note.frontmatter),
  });

  return dossier;
}

function committedNotePaths(vaultRoot: string): string[] {
  const manifest = loadManifest(vaultRoot);
  return manifest.sources
    .filter((record) => record.status === "committed" && record.note_path !== undefined)
    .map((record) => record.note_path as string)
    .sort((left, right) => left.localeCompare(right));
}

export function generateVaultDossiers(vaultRoot: string): DossierSetResult {
  const root = resolve(vaultRoot);
  const initIssues = checkVaultInitialization(root);
  if (initIssues.length > 0) {
    throw new Error(initIssues[0]?.message ?? "Vault is not initialized.");
  }

  const manifest = loadManifest(root);
  const graph = buildVaultLinkGraph(root);
  const dossiers: NoteDossier[] = [];

  for (const notePath of committedNotePaths(root)) {
    if (!isVaultRelativePath(notePath)) {
      continue;
    }
    const absolutePath = join(root, notePath);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }

    const content = fs.readFileSync(absolutePath, "utf8");
    const parsed = parseNoteContent(notePath, content);
    if (Array.isArray(parsed)) {
      continue;
    }

    const dossier = buildNoteDossier(parsed, graph);
    if (dossier !== null) {
      dossiers.push(dossier);
    }
  }

  dossiers.sort((left, right) => left.path.localeCompare(right.path));

  return {
    schema_version: DOSSIER_SET_SCHEMA_VERSION,
    contract_version: manifest.note_contract_version,
    dossiers,
    count: dossiers.length,
  };
}

export function dossierContainsCredentialKeys(value: unknown, path = ""): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => dossierContainsCredentialKeys(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const hits: string[] = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path.length > 0 ? `${path}.${key}` : key;
      if (CREDENTIAL_FIELD_PATTERN.test(key)) {
        hits.push(nextPath);
      }
      hits.push(...dossierContainsCredentialKeys(nested, nextPath));
    }
    return hits;
  }
  return [];
}

export function handleDossier(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("dossier", "USAGE_MISSING_ARGS", "Usage: dossier <vault-root>"),
      diagnostic: "Missing required argument for dossier.",
    };
  }

  try {
    const result = generateVaultDossiers(vaultRoot);
    return {
      exitCode: ExitCode.SUCCESS,
      result: success("dossier", { ...result }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Dossier generation failed";
    const initFailed = message.includes("not initialized") || message.includes("missing");
    return {
      exitCode: initFailed ? ExitCode.VALIDATION : ExitCode.UNEXPECTED,
      result: failure("dossier", initFailed ? "VAULT_NOT_INITIALIZED" : "DOSSIER_FAILED", message),
      diagnostic: message,
    };
  }
}
