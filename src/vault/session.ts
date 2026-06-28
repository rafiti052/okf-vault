import { existsSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_RELATIVE_PATH } from "./constants.js";
import type { IngestSourceInput } from "./ingestion.js";

const KNOWLEDGE_DIR = "knowledge";

export type SkillMode = "initialize" | "ingest" | "organize" | "validate" | "visualize";

export const SKILL_MODES = [
  "initialize",
  "ingest",
  "organize",
  "validate",
  "visualize",
] as const satisfies readonly SkillMode[];

export type SessionExitStatus = "completed" | "failed" | "aborted" | "skipped";

export const SESSION_EXIT_STATUSES = [
  "completed",
  "failed",
  "aborted",
  "skipped",
] as const satisfies readonly SessionExitStatus[];

export type SessionSourceKind = "local" | "google_drive" | "granola" | "youtube";

export const SESSION_SOURCE_KINDS = [
  "local",
  "google_drive",
  "granola",
  "youtube",
] as const satisfies readonly SessionSourceKind[];

export interface VaultSessionContext {
  vault_root: string;
  last_run_id: string | null;
  last_mode: SkillMode | null;
  last_exit_status: SessionExitStatus | null;
  last_source_kind: SessionSourceKind | null;
}

export type IngestWizardStep =
  | "resolve_vault"
  | "choose_source_type"
  | "acquire_mcp"
  | "acquire_local"
  | "confirm_source"
  | "delegate_ingest"
  | "post_commit";

export const INGEST_WIZARD_STEPS = [
  "resolve_vault",
  "choose_source_type",
  "acquire_mcp",
  "acquire_local",
  "confirm_source",
  "delegate_ingest",
  "post_commit",
] as const satisfies readonly IngestWizardStep[];

export interface IngestWizardState {
  step: IngestWizardStep;
  source_type: "mcp_artifact" | "local_file" | null;
  pending_source: IngestSourceInput | null;
  run_id: string;
}

export interface VaultResolveResult {
  status: "found" | "not_initialized";
  vault_root: string | null;
}

export class SessionContextError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "SessionContextError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function assertNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new SessionContextError(`${field} must be a string or null`, "INVALID_FIELD_TYPE");
  }
  return value;
}

function assertNullableEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new SessionContextError(
      `${field} must be one of ${allowed.join(", ")} or null`,
      "INVALID_ENUM_VALUE",
    );
  }
  return value as T;
}

export function parseVaultSessionContext(input: unknown): VaultSessionContext {
  if (!isRecord(input)) {
    throw new SessionContextError("Session context must be an object", "INVALID_CONTEXT_SHAPE");
  }

  if (!("vault_root" in input)) {
    throw new SessionContextError("vault_root is required", "MISSING_VAULT_ROOT");
  }
  if (!isNonEmptyString(input.vault_root)) {
    throw new SessionContextError("vault_root must be a non-empty string", "INVALID_VAULT_ROOT");
  }

  return {
    vault_root: input.vault_root.trim(),
    last_run_id: assertNullableString(input.last_run_id, "last_run_id"),
    last_mode: assertNullableEnum(input.last_mode, "last_mode", SKILL_MODES),
    last_exit_status: assertNullableEnum(
      input.last_exit_status,
      "last_exit_status",
      SESSION_EXIT_STATUSES,
    ),
    last_source_kind: assertNullableEnum(
      input.last_source_kind,
      "last_source_kind",
      SESSION_SOURCE_KINDS,
    ),
  };
}

export function createDefaultSessionContext(vaultRoot: string): VaultSessionContext {
  return parseVaultSessionContext({
    vault_root: vaultRoot,
    last_run_id: null,
    last_mode: null,
    last_exit_status: null,
    last_source_kind: null,
  });
}

export function resolveVaultRoot(repoRoot: string): VaultResolveResult {
  const knowledgeManifestPath = join(repoRoot, KNOWLEDGE_DIR, MANIFEST_RELATIVE_PATH);
  if (existsSync(knowledgeManifestPath)) {
    return {
      status: "found",
      vault_root: join(repoRoot, KNOWLEDGE_DIR),
    };
  }

  const legacyManifestPath = join(repoRoot, MANIFEST_RELATIVE_PATH);
  if (existsSync(legacyManifestPath)) {
    return {
      status: "found",
      vault_root: repoRoot,
    };
  }

  return {
    status: "not_initialized",
    vault_root: null,
  };
}
