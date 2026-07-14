import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { SOURCE_SPAN_CONTRACT_VERSION, SOURCE_SPANS_DIR } from "./constants.js";
import type { SourceSpanIndex, SourceSpanProfile, SourceSpanRef } from "./manifest.js";
import {
  createSourceSpanId,
  createSourceSpanRelativePath,
  createSourceSpanSourceSlug,
} from "./source-spans.js";
import type { SourceAnchor, ValidationIssue } from "./validation.js";

export const SOURCE_SPAN_VALIDATION_CODES = {
  missing: "SOURCE_SPAN_MISSING",
  documentInvalid: "SOURCE_SPAN_DOCUMENT_INVALID",
  pathInvalid: "SOURCE_SPAN_PATH_INVALID",
  indexInvalid: "SOURCE_SPAN_INDEX_INVALID",
  indexMismatch: "SOURCE_SPAN_INDEX_MISMATCH",
  hashMismatch: "SOURCE_SPAN_HASH_MISMATCH",
  anchorUnresolved: "SOURCE_SPAN_ANCHOR_UNRESOLVED",
  anchorAmbiguous: "SOURCE_SPAN_ANCHOR_AMBIGUOUS",
  siblingInvalid: "SOURCE_SPAN_SIBLING_INVALID",
  expansionUnbounded: "SOURCE_SPAN_EXPANSION_UNBOUNDED",
} as const;

export interface SourceSpanMarkdownDocument {
  relativePath: string;
  content: string;
}

export interface SourceSpanValidationEnvelope {
  source_key: string;
  content_sha256: string;
  anchors: readonly SourceAnchor[];
}

export interface SourceSpanValidationInput {
  profile: SourceSpanProfile;
  envelope: SourceSpanValidationEnvelope;
  index?: SourceSpanIndex;
  documents: readonly SourceSpanMarkdownDocument[];
}

interface ParsedSourceSpan {
  relativePath: string;
  content: string;
  body: string;
  metadata: ParsedSourceSpanMetadata;
  timestamp?: string;
}

interface ParsedSourceSpanMetadata {
  spanId: string;
  sourceKey: string;
  contentSha256: string;
  profile: SourceSpanProfile;
  sequence: number;
  anchorIds: string[];
  prev?: string;
  next?: string;
  speaker?: string;
  slideNumber?: number;
  anchorKind?: string;
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SOURCE_SPAN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const FRONTMATTER_KEYS = new Set([
  "type",
  "title",
  "description",
  "contract_version",
  "resource",
  "timestamp",
  "tags",
  "okv",
]);
const METADATA_KEYS = new Set([
  "span_id",
  "source_key",
  "content_sha256",
  "profile",
  "sequence",
  "anchor_ids",
  "prev",
  "next",
  "speaker",
  "slide_number",
  "anchor_kind",
  "heading",
  "parent_label",
]);
const INDEX_KEYS = new Set(["schema_version", "profile", "default_expansion", "spans"]);
const INDEX_EXPANSION_KEYS = new Set(["previous", "next"]);
const INDEX_ENTRY_KEYS = new Set([
  "id",
  "path",
  "sha256",
  "profile",
  "sequence",
  "anchor_ids",
  "prev_id",
  "next_id",
]);
const PROFILES = new Set<unknown>(["article", "video", "panel", "deck"]);

function issue(code: string, message: string, path?: string): ValidationIssue {
  return path === undefined ? { code, message } : { code, message, path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  relativePath: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!nonEmptyString(value)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span field '${key}' must be a non-empty string when present.`,
        relativePath,
      ),
    );
    return undefined;
  }
  return value.trim();
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  relativePath: string,
  issues: ValidationIssue[],
): string | undefined {
  const value = optionalString(record, key, relativePath, issues);
  if (record[key] === undefined) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span field '${key}' is required.`,
        relativePath,
      ),
    );
  }
  return value;
}

function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.startsWith("/") || relativePath.includes("\\")) {
    return false;
  }
  const segments = relativePath.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export function sourceSpanContentSha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function parseFrontmatter(
  document: SourceSpanMarkdownDocument,
  issues: ValidationIssue[],
): { frontmatter: Record<string, unknown>; body: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(document.content);
  if (match === null) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span document must contain YAML frontmatter followed by a Markdown body.",
        document.relativePath,
      ),
    );
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span frontmatter YAML could not be parsed.",
        document.relativePath,
      ),
    );
    return undefined;
  }

  if (!isRecord(parsed)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span frontmatter must be a YAML mapping.",
        document.relativePath,
      ),
    );
    return undefined;
  }

  return { frontmatter: parsed, body: match[2] ?? "" };
}

function validateKnownKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  relativePath: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          `Unknown ${label} field '${key}' is not allowed.`,
          relativePath,
        ),
      );
    }
  }
}

function parseMetadata(
  value: unknown,
  relativePath: string,
  issues: ValidationIssue[],
): ParsedSourceSpanMetadata | undefined {
  if (!isRecord(value)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span frontmatter requires an 'okv' metadata mapping.",
        relativePath,
      ),
    );
    return undefined;
  }
  validateKnownKeys(value, METADATA_KEYS, "okv metadata", relativePath, issues);

  const spanId = requiredString(value, "span_id", relativePath, issues);
  const sourceKey = requiredString(value, "source_key", relativePath, issues);
  const contentSha256 = requiredString(value, "content_sha256", relativePath, issues);
  const profile = requiredString(value, "profile", relativePath, issues);
  const sequence = value.sequence;
  const anchorIds = value.anchor_ids;
  const prev = optionalString(value, "prev", relativePath, issues);
  const next = optionalString(value, "next", relativePath, issues);
  const speaker = optionalString(value, "speaker", relativePath, issues);
  const anchorKind = optionalString(value, "anchor_kind", relativePath, issues);
  optionalString(value, "heading", relativePath, issues);
  optionalString(value, "parent_label", relativePath, issues);

  if (spanId !== undefined && !SOURCE_SPAN_ID_PATTERN.test(spanId)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span ID '${spanId}' is malformed.`,
        relativePath,
      ),
    );
  }
  for (const [field, siblingId] of [
    ["prev", prev],
    ["next", next],
  ] as const) {
    if (siblingId !== undefined && !SOURCE_SPAN_ID_PATTERN.test(siblingId)) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.siblingInvalid,
          `Source-span ${field} sibling ID '${siblingId}' is malformed.`,
          relativePath,
        ),
      );
    }
  }
  if (contentSha256 !== undefined && !SHA256_PATTERN.test(contentSha256)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span content_sha256 must be a lowercase SHA-256 digest.",
        relativePath,
      ),
    );
  }
  if (profile !== undefined && !PROFILES.has(profile)) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Unsupported source-span profile '${profile}'.`,
        relativePath,
      ),
    );
  }
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span sequence must be a positive safe integer.",
        relativePath,
      ),
    );
  }

  let normalizedAnchorIds: string[] | undefined;
  if (
    !Array.isArray(anchorIds) ||
    anchorIds.some((anchorId) => !nonEmptyString(anchorId)) ||
    new Set(anchorIds).size !== anchorIds.length
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span anchor_ids must be an array of unique non-empty strings.",
        relativePath,
      ),
    );
  } else {
    normalizedAnchorIds = anchorIds.map((anchorId) => (anchorId as string).trim());
  }

  const slideNumber = value.slide_number;
  if (
    slideNumber !== undefined &&
    (!Number.isSafeInteger(slideNumber) || (slideNumber as number) < 1)
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span slide_number must be a positive safe integer when present.",
        relativePath,
      ),
    );
  }

  if (
    spanId === undefined ||
    sourceKey === undefined ||
    contentSha256 === undefined ||
    profile === undefined ||
    !PROFILES.has(profile) ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 1 ||
    normalizedAnchorIds === undefined
  ) {
    return undefined;
  }

  return {
    spanId,
    sourceKey,
    contentSha256,
    profile: profile as SourceSpanProfile,
    sequence: sequence as number,
    anchorIds: normalizedAnchorIds,
    ...(prev === undefined ? {} : { prev }),
    ...(next === undefined ? {} : { next }),
    ...(speaker === undefined ? {} : { speaker }),
    ...(slideNumber === undefined ? {} : { slideNumber: slideNumber as number }),
    ...(anchorKind === undefined ? {} : { anchorKind }),
  };
}

function validateProfileShape(
  parsed: ParsedSourceSpan,
  expectedProfile: SourceSpanProfile,
  issues: ValidationIssue[],
): void {
  const { metadata, relativePath, timestamp } = parsed;
  if (metadata.profile !== expectedProfile) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span profile '${metadata.profile}' does not match '${expectedProfile}'.`,
        relativePath,
      ),
    );
    return;
  }

  if (expectedProfile === "video") {
    if (timestamp === undefined || metadata.anchorKind !== "timestamp") {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          "Video source spans require timestamp frontmatter and anchor_kind 'timestamp'.",
          relativePath,
        ),
      );
    }
  } else if (expectedProfile === "panel") {
    const allowedKinds = new Set(["speaker", "timestamp", "timestamp-speaker"]);
    if (metadata.anchorKind === undefined || !allowedKinds.has(metadata.anchorKind)) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          "Panel source spans require a speaker, timestamp, or timestamp-speaker anchor_kind.",
          relativePath,
        ),
      );
    }
    if (metadata.anchorKind?.includes("timestamp") === true && timestamp === undefined) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          "Timestamped panel source spans require timestamp frontmatter.",
          relativePath,
        ),
      );
    }
    if (metadata.anchorKind?.includes("speaker") === true && metadata.speaker === undefined) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          "Speaker-attributed panel source spans require okv.speaker metadata.",
          relativePath,
        ),
      );
    }
  } else if (expectedProfile === "deck") {
    if (
      metadata.slideNumber === undefined ||
      (metadata.anchorKind !== "slide" && metadata.anchorKind !== "speaker_note")
    ) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
          "Deck source spans require slide_number and a slide or speaker_note anchor_kind.",
          relativePath,
        ),
      );
    }
  }
}

function parseDocument(
  document: SourceSpanMarkdownDocument,
  input: SourceSpanValidationInput,
  issues: ValidationIssue[],
): ParsedSourceSpan | undefined {
  if (
    !isSafeRelativePath(document.relativePath) ||
    !document.relativePath.startsWith(`${SOURCE_SPANS_DIR}/`)
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.pathInvalid,
        `Source-span path must stay under '${SOURCE_SPANS_DIR}/'.`,
        isSafeRelativePath(document.relativePath) ? document.relativePath : undefined,
      ),
    );
    return undefined;
  }

  const parsed = parseFrontmatter(document, issues);
  if (parsed === undefined) {
    return undefined;
  }
  const { frontmatter, body } = parsed;
  validateKnownKeys(frontmatter, FRONTMATTER_KEYS, "frontmatter", document.relativePath, issues);

  if (frontmatter.type !== "Source Span") {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span type must be 'Source Span'.",
        document.relativePath,
      ),
    );
  }
  requiredString(frontmatter, "title", document.relativePath, issues);
  requiredString(frontmatter, "description", document.relativePath, issues);
  if (frontmatter.contract_version !== SOURCE_SPAN_CONTRACT_VERSION) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span contract_version must be '${SOURCE_SPAN_CONTRACT_VERSION}'.`,
        document.relativePath,
      ),
    );
  }
  optionalString(frontmatter, "resource", document.relativePath, issues);
  const timestamp = optionalString(frontmatter, "timestamp", document.relativePath, issues);
  const tags = frontmatter.tags;
  if (
    !Array.isArray(tags) ||
    tags.length === 0 ||
    tags.some((tag) => !nonEmptyString(tag)) ||
    new Set(tags).size !== tags.length
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span tags must be a non-empty array of unique non-empty strings.",
        document.relativePath,
      ),
    );
  }
  if (body.trim().length === 0) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span Markdown body must be non-empty.",
        document.relativePath,
      ),
    );
  }

  const metadata = parseMetadata(frontmatter.okv, document.relativePath, issues);
  if (metadata === undefined) {
    return undefined;
  }

  if (
    metadata.sourceKey !== input.envelope.source_key ||
    metadata.contentSha256 !== input.envelope.content_sha256
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span source identity or content hash does not match the source envelope.",
        document.relativePath,
      ),
    );
  }

  const expectedId = createSourceSpanId(
    input.envelope.source_key,
    input.envelope.content_sha256,
    input.profile,
    metadata.sequence,
  );
  if (metadata.spanId !== expectedId) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        `Source-span ID '${metadata.spanId}' does not match its deterministic identity.`,
        document.relativePath,
      ),
    );
  }

  const sourceSlug = createSourceSpanSourceSlug(
    input.envelope.source_key,
    input.envelope.content_sha256,
  );
  const expectedPath = createSourceSpanRelativePath(sourceSlug, metadata.sequence);
  if (document.relativePath !== expectedPath) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.pathInvalid,
        `Source-span path '${document.relativePath}' must be '${expectedPath}'.`,
        document.relativePath,
      ),
    );
  }

  const result: ParsedSourceSpan = {
    relativePath: document.relativePath,
    content: document.content,
    body,
    metadata,
    ...(timestamp === undefined ? {} : { timestamp }),
  };
  validateProfileShape(result, input.profile, issues);
  return result;
}

function normalizedIndexEntries(
  index: SourceSpanIndex,
  input: SourceSpanValidationInput,
  issues: ValidationIssue[],
): SourceSpanRef[] {
  if (Object.keys(index).some((key) => !INDEX_KEYS.has(key))) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
        "Source-span index contains unknown fields.",
      ),
    );
  }
  if (index.schema_version !== SOURCE_SPAN_CONTRACT_VERSION || index.profile !== input.profile) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
        "Source-span index schema version and profile must match the validation request.",
      ),
    );
  }

  if (index.default_expansion?.previous !== 1 || index.default_expansion?.next !== 1) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.expansionUnbounded,
        "Source-span expansion must be bounded to one previous and one next sibling.",
      ),
    );
  }
  if (
    !isRecord(index.default_expansion) ||
    Object.keys(index.default_expansion).some((key) => !INDEX_EXPANSION_KEYS.has(key))
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
        "Source-span index default_expansion is malformed.",
      ),
    );
  }

  if (!Array.isArray(index.spans) || index.spans.length === 0) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.missing,
        "Source-span index must contain at least one span entry.",
      ),
    );
    return [];
  }

  const entries: SourceSpanRef[] = [];
  for (const entry of index.spans as readonly SourceSpanRef[]) {
    if (isRecord(entry) && Object.keys(entry).some((key) => !INDEX_ENTRY_KEYS.has(key))) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
          "Source-span index entry contains unknown fields.",
          nonEmptyString(entry.path) && isSafeRelativePath(entry.path) ? entry.path : undefined,
        ),
      );
    }
    if (
      !isRecord(entry) ||
      !nonEmptyString(entry.id) ||
      !nonEmptyString(entry.path) ||
      !isSafeRelativePath(entry.path) ||
      !SHA256_PATTERN.test(entry.sha256) ||
      entry.profile !== input.profile ||
      !Number.isSafeInteger(entry.sequence) ||
      entry.sequence < 1 ||
      !Array.isArray(entry.anchor_ids) ||
      entry.anchor_ids.some((anchorId) => !nonEmptyString(anchorId)) ||
      new Set(entry.anchor_ids).size !== entry.anchor_ids.length ||
      (entry.prev_id !== undefined && !nonEmptyString(entry.prev_id)) ||
      (entry.next_id !== undefined && !nonEmptyString(entry.next_id))
    ) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
          "Source-span index contains a malformed span entry.",
          isRecord(entry) && nonEmptyString(entry.path) && isSafeRelativePath(entry.path)
            ? entry.path
            : undefined,
        ),
      );
      continue;
    }
    entries.push(entry);

    const sourceSlug = createSourceSpanSourceSlug(
      input.envelope.source_key,
      input.envelope.content_sha256,
    );
    const expectedPath = createSourceSpanRelativePath(sourceSlug, entry.sequence);
    const expectedId = createSourceSpanId(
      input.envelope.source_key,
      input.envelope.content_sha256,
      input.profile,
      entry.sequence,
    );
    if (!entry.path.startsWith(`${SOURCE_SPANS_DIR}/`) || entry.path !== expectedPath) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.pathInvalid,
          `Indexed source-span path '${entry.path}' must be '${expectedPath}'.`,
          entry.path,
        ),
      );
    }
    if (entry.id !== expectedId) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.indexMismatch,
          `Indexed source-span ID '${entry.id}' does not match its deterministic identity.`,
          entry.path,
        ),
      );
    }
  }

  const ids = entries.map((entry) => entry.id);
  const paths = entries.map((entry) => entry.path);
  const sequences = entries.map((entry) => entry.sequence);
  if (
    new Set(ids).size !== ids.length ||
    new Set(paths).size !== paths.length ||
    new Set(sequences).size !== sequences.length
  ) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.indexInvalid,
        "Source-span index IDs, paths, and sequences must be unique.",
      ),
    );
  }

  return entries.sort((left, right) => left.sequence - right.sequence);
}

function validateIndexAndSiblings(
  input: SourceSpanValidationInput,
  parsedSpans: readonly ParsedSourceSpan[],
  issues: ValidationIssue[],
): void {
  if (input.index === undefined) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.missing,
        "Generated source-span documents require a source-span index.",
      ),
    );
    return;
  }
  if (!isRecord(input.index)) {
    issues.push(
      issue(SOURCE_SPAN_VALIDATION_CODES.indexInvalid, "Source-span index must be an object."),
    );
    return;
  }

  const entries = normalizedIndexEntries(input.index, input, issues);
  const documentsByPath = new Map(
    input.documents.map((document) => [document.relativePath, document]),
  );
  const parsedByPath = new Map(parsedSpans.map((span) => [span.relativePath, span]));
  const indexedPaths = new Set(entries.map((entry) => entry.path));

  if (documentsByPath.size !== input.documents.length) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.indexMismatch,
        "Source-span document paths must be unique.",
      ),
    );
  }

  for (const document of input.documents) {
    if (!indexedPaths.has(document.relativePath)) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.indexMismatch,
          "Source-span document is not present in the source-span index.",
          isSafeRelativePath(document.relativePath) ? document.relativePath : undefined,
        ),
      );
    }
  }

  for (const [position, entry] of entries.entries()) {
    const document = documentsByPath.get(entry.path);
    if (document === undefined) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.missing,
          `Indexed source-span document '${entry.path}' is missing.`,
          entry.path,
        ),
      );
      continue;
    }
    if (sourceSpanContentSha256(document.content) !== entry.sha256) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.hashMismatch,
          `Indexed SHA-256 does not match source-span bytes for '${entry.path}'.`,
          entry.path,
        ),
      );
    }

    const parsed = parsedByPath.get(entry.path);
    if (parsed === undefined) {
      continue;
    }
    const metadata = parsed.metadata;
    const expectedPrev = position > 0 ? entries[position - 1]?.id : undefined;
    const expectedNext = position + 1 < entries.length ? entries[position + 1]?.id : undefined;
    const expectedSequence = position + 1;

    if (
      entry.sequence !== expectedSequence ||
      metadata.sequence !== entry.sequence ||
      metadata.spanId !== entry.id ||
      metadata.profile !== entry.profile ||
      metadata.sourceKey !== input.envelope.source_key ||
      metadata.contentSha256 !== input.envelope.content_sha256 ||
      JSON.stringify([...metadata.anchorIds].sort()) !==
        JSON.stringify([...entry.anchor_ids].sort())
    ) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.indexMismatch,
          "Source-span document metadata does not match its index entry.",
          entry.path,
        ),
      );
    }

    if (
      entry.prev_id !== expectedPrev ||
      entry.next_id !== expectedNext ||
      metadata.prev !== expectedPrev ||
      metadata.next !== expectedNext
    ) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.siblingInvalid,
          "Source-span sibling links must point only to the immediate ordered neighbors.",
          entry.path,
        ),
      );
    }
  }
}

function anchorIsRequired(profile: SourceSpanProfile, anchor: SourceAnchor): boolean {
  if (!nonEmptyString(anchor.id)) {
    return false;
  }
  switch (profile) {
    case "article":
      return nonEmptyString(anchor.text);
    case "video":
      return anchor.kind === "timestamp";
    case "panel":
      return (
        (anchor.kind === "speaker" || anchor.kind === "timestamp") && nonEmptyString(anchor.text)
      );
    case "deck":
      return anchor.kind === "slide" || anchor.kind === "speaker_note";
  }
}

function validateAnchorCoverage(
  input: SourceSpanValidationInput,
  parsedSpans: readonly ParsedSourceSpan[],
  issues: ValidationIssue[],
): void {
  const envelopeAnchorIds = new Set(input.envelope.anchors.map((anchor) => anchor.id));
  const coverage = new Map<string, string[]>();

  for (const span of parsedSpans) {
    for (const anchorId of span.metadata.anchorIds) {
      const anchor = input.envelope.anchors.find((entry) => entry.id === anchorId);
      if (!envelopeAnchorIds.has(anchorId) || anchor === undefined) {
        issues.push(
          issue(
            SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved,
            `Source-span anchor '${anchorId}' is not present in the source envelope.`,
            span.relativePath,
          ),
        );
      } else if (!anchorMatchesSpan(input.profile, anchor, span)) {
        issues.push(
          issue(
            SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved,
            `Source-span anchor '${anchorId}' does not match its ${input.profile} metadata.`,
            span.relativePath,
          ),
        );
      }
      coverage.set(anchorId, [...(coverage.get(anchorId) ?? []), span.relativePath]);
    }
  }

  for (const anchor of input.envelope.anchors.filter((entry) =>
    anchorIsRequired(input.profile, entry),
  )) {
    const paths = coverage.get(anchor.id) ?? [];
    if (paths.length === 0) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved,
          `Required ${input.profile} anchor '${anchor.id}' is not covered by a source span.`,
        ),
      );
    } else if (paths.length > 1) {
      issues.push(
        issue(
          SOURCE_SPAN_VALIDATION_CODES.anchorAmbiguous,
          `Anchor '${anchor.id}' resolves to more than one source span.`,
        ),
      );
    }
  }
}

function anchorMatchesSpan(
  profile: SourceSpanProfile,
  anchor: SourceAnchor,
  span: ParsedSourceSpan,
): boolean {
  switch (profile) {
    case "article":
      return nonEmptyString(anchor.text);
    case "video":
      return anchor.kind === "timestamp" && anchor.timestamp?.trim() === span.timestamp;
    case "panel": {
      if (anchor.kind === "timestamp") {
        return anchor.timestamp?.trim() === span.timestamp;
      }
      if (anchor.kind !== "speaker") {
        return false;
      }
      const anchorSpeaker = anchor.speaker?.trim() ?? anchor.label?.trim();
      return anchorSpeaker === undefined || anchorSpeaker === span.metadata.speaker;
    }
    case "deck":
      return (
        anchor.kind === span.metadata.anchorKind &&
        anchor.slide_number === span.metadata.slideNumber
      );
  }
}

/** Validates rendered source-span Markdown and its fail-closed manifest index contract. */
export function validateSourceSpanDocuments(input: SourceSpanValidationInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (
    !nonEmptyString(input.envelope.source_key) ||
    !SHA256_PATTERN.test(input.envelope.content_sha256) ||
    !PROFILES.has(input.profile)
  ) {
    return [
      issue(
        SOURCE_SPAN_VALIDATION_CODES.documentInvalid,
        "Source-span validation requires a supported profile and valid source identity hash.",
      ),
    ];
  }
  if (input.documents.length === 0) {
    issues.push(
      issue(
        SOURCE_SPAN_VALIDATION_CODES.missing,
        "At least one generated source-span document is required.",
      ),
    );
  }

  const parsedSpans = input.documents
    .map((document) => parseDocument(document, input, issues))
    .filter((span): span is ParsedSourceSpan => span !== undefined);

  validateIndexAndSiblings(input, parsedSpans, issues);
  validateAnchorCoverage(input, parsedSpans, issues);
  return issues;
}
