import { copyFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  deriveSourceKey,
  inspectSource,
  loadManifest,
  manifestRevision,
  saveManifest,
  upsertSkippedSource,
  type InspectOutcome,
  type Manifest,
  type SourceKind,
  type SourceRecord,
} from "./manifest.js";
import { NOTE_CONTRACT_VERSION } from "./constants.js";
import { commitStagedSource, type CommitStagedResult } from "./transaction.js";
import { loadSourceEnvelope } from "./validation.js";

/** Ordered progress events for a single-source ingest happy path (task 10 contract). */
export const HAPPY_PATH_PROGRESS_EVENTS = [
  "run_started",
  "preflight_passed",
  "source_acquired",
  "conversion_started",
  "source_committed",
  "run_completed",
] as const;

export type HappyPathProgressEvent = (typeof HAPPY_PATH_PROGRESS_EVENTS)[number];

export type ConversionProfile = "article" | "deck" | "panel" | "video";

export interface IngestSourceInput {
  kind: SourceKind;
  locator: string;
  content_type: string;
}

export interface IngestRunInput {
  vault_root: string;
  run_id: string;
  sources: IngestSourceInput[];
}

export type ProgressEventStatus = "ok" | "skipped" | "failed";

export interface ProgressEvent {
  event: string;
  run_id: string;
  phase: string;
  status: ProgressEventStatus;
  timestamp: string;
  duration_ms: number;
  source_key?: string;
  error_code?: string;
  commit_id?: string;
  message?: string;
}

export class IngestInputError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "IngestInputError";
  }
}

export function parseIngestRunInput(input: IngestRunInput): IngestRunInput {
  if (input.sources.length === 0) {
    throw new IngestInputError(
      "Ingest run requires at least one explicit source",
      "EMPTY_SOURCE_LIST",
    );
  }

  const seenKeys = new Set<string>();
  for (const source of input.sources) {
    const sourceKey = deriveSourceKey(source.kind, source.locator);
    if (seenKeys.has(sourceKey)) {
      throw new IngestInputError(
        `Duplicate source key in run definition: ${sourceKey}`,
        "DUPLICATE_SOURCE_KEY",
      );
    }
    seenKeys.add(sourceKey);
  }

  return input;
}

export interface ConversionProfileHints {
  kind?: SourceKind;
  hasSlides?: boolean;
  /** Curator-confirmed profile for ambiguous YouTube transcript acquisition. */
  confirmedProfile?: ConversionProfile;
}

export function selectConversionProfile(
  contentType: string,
  hints: ConversionProfileHints = {},
): ConversionProfile {
  const normalized = contentType.toLowerCase();
  if (
    hints.hasSlides === true ||
    normalized.includes("presentation") ||
    normalized.includes("deck") ||
    normalized.includes("slide")
  ) {
    return "deck";
  }
  if (hints.kind === "granola") {
    return "panel";
  }
  if (hints.kind === "youtube") {
    if (hints.confirmedProfile === "panel" || normalized.includes("panel")) {
      return "panel";
    }
    return "video";
  }
  if (
    normalized.includes("video") ||
    normalized.includes("transcript") ||
    normalized.includes("recording")
  ) {
    return "video";
  }
  if (normalized.includes("panel") || normalized.includes("discussion")) {
    return "panel";
  }
  return "article";
}

export interface ManifestPreflightResult {
  outcome: InspectOutcome;
  source_key: string;
  stop_before_conversion: boolean;
  existing_note_path?: string;
  progress_event: ProgressEvent;
}

function buildProgressEvent(
  event: string,
  runId: string,
  phase: string,
  status: ProgressEventStatus,
  options: {
    source_key?: string;
    error_code?: string;
    commit_id?: string;
    message?: string;
    duration_ms?: number;
  } = {},
): ProgressEvent {
  return {
    event,
    run_id: runId,
    phase,
    status,
    timestamp: new Date().toISOString(),
    duration_ms: options.duration_ms ?? 0,
    ...(options.source_key !== undefined ? { source_key: options.source_key } : {}),
    ...(options.error_code !== undefined ? { error_code: options.error_code } : {}),
    ...(options.commit_id !== undefined ? { commit_id: options.commit_id } : {}),
    ...(options.message !== undefined ? { message: options.message } : {}),
  };
}

export function resolveManifestPreflight(
  manifest: Manifest,
  kind: SourceKind,
  origin: string,
  contentSha256: string,
  runId: string,
): ManifestPreflightResult {
  const sourceKey = deriveSourceKey(kind, origin);
  const outcome = inspectSource(manifest, sourceKey, contentSha256);
  const existing = manifest.sources.find((record) => record.source_key === sourceKey);

  if (outcome === "already_processed") {
    return {
      outcome,
      source_key: sourceKey,
      stop_before_conversion: true,
      ...(existing?.note_path !== undefined ? { existing_note_path: existing.note_path } : {}),
      progress_event: buildProgressEvent("source_already_processed", runId, "inspect", "ok", {
        source_key: sourceKey,
        message: "Source unchanged; skipping conversion and commit.",
      }),
    };
  }

  if (outcome === "changed_conflict") {
    return {
      outcome,
      source_key: sourceKey,
      stop_before_conversion: true,
      ...(existing?.note_path !== undefined ? { existing_note_path: existing.note_path } : {}),
      progress_event: buildProgressEvent("run_failed", runId, "inspect", "failed", {
        source_key: sourceKey,
        error_code: "SOURCE_CHANGED_CONFLICT",
        message: "Source content hash changed for an existing manifest record.",
      }),
    };
  }

  return {
    outcome,
    source_key: sourceKey,
    stop_before_conversion: false,
    progress_event: buildProgressEvent("conversion_started", runId, "convert", "ok", {
      source_key: sourceKey,
    }),
  };
}

export interface RecordSkippedSourceInput {
  vaultRoot: string;
  kind: SourceKind;
  origin: string;
  contentSha256: string;
  reason: string;
  runId: string;
  errorCode?: string;
}

export interface RecordSkippedSourceResult {
  record: SourceRecord;
  revision: string;
  progress_event: ProgressEvent;
}

export function recordSkippedSource(input: RecordSkippedSourceInput): RecordSkippedSourceResult {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new IngestInputError("Skip reason must be non-empty", "SKIP_REASON_EMPTY");
  }

  const manifest = loadManifest(input.vaultRoot);
  const sourceKey = deriveSourceKey(input.kind, input.origin);
  const processedAt = new Date().toISOString();
  const record: SourceRecord = {
    source_key: sourceKey,
    kind: input.kind,
    origin: input.origin,
    content_sha256: input.contentSha256,
    contract_version: NOTE_CONTRACT_VERSION,
    status: "skipped",
    skip_reason: reason,
    processed_at: processedAt,
  };

  const updated = upsertSkippedSource(manifest, record);
  saveManifest(input.vaultRoot, updated);

  return {
    record,
    revision: manifestRevision(updated),
    progress_event: buildProgressEvent("validation_failed", input.runId, "validate", "skipped", {
      source_key: sourceKey,
      error_code: input.errorCode ?? "SOURCE_SKIPPED",
      message: reason,
    }),
  };
}

export interface IngestFixtureCommitInput {
  vaultRoot: string;
  runId: string;
  envelopePath: string;
  goldNotePath: string;
  stagedNotePath: string;
  expectedRevision: string;
}

export function stageIngestFixture(input: IngestFixtureCommitInput): string {
  const stagingDir = join(resolve(input.vaultRoot), ".okf-vault", "tmp", input.runId);
  const targetDir = join(stagingDir, dirname(input.stagedNotePath));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(input.goldNotePath, join(stagingDir, input.stagedNotePath));
  return stagingDir;
}

export function commitIngestFixture(input: IngestFixtureCommitInput): CommitStagedResult {
  stageIngestFixture(input);
  return commitStagedSource({
    vaultRoot: input.vaultRoot,
    runId: input.runId,
    envelopePath: input.envelopePath,
    expectedRevision: input.expectedRevision,
  });
}

export interface IngestFixturePair {
  kind: ConversionProfile;
  envelopePath: string;
  goldNotePath: string;
  stagedNotePath: string;
}

export function defaultStagedNotePath(profile: ConversionProfile, goldNotePath: string): string {
  const stem = basename(goldNotePath, ".md");
  switch (profile) {
    case "article":
      return `notes/gold-article-${stem.replace("accepted-", "")}.md`;
    case "deck":
      return `notes/gold-deck-${stem.replace("accepted-", "")}.md`;
    case "panel":
      return `notes/gold-panel-${stem.replace("accepted-", "")}.md`;
    case "video":
      return `notes/gold-video-${stem.replace("accepted-", "")}.md`;
    default: {
      const exhaustive: never = profile;
      throw new Error(`Unsupported profile: ${String(exhaustive)}`);
    }
  }
}

export function envelopeHasSlides(envelopePath: string): boolean {
  const envelope = loadSourceEnvelope(envelopePath);
  return Array.isArray(envelope.slides) && envelope.slides.length > 0;
}
