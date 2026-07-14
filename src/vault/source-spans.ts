import { createHash } from "node:crypto";
import { posix } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { SOURCE_SPAN_CONTRACT_VERSION, SOURCE_SPANS_DIR } from "./constants.js";

export const SOURCE_SPAN_PROFILES = ["article", "video", "panel", "deck"] as const;

export type SourceSpanProfile = (typeof SOURCE_SPAN_PROFILES)[number];

export interface SourceSpanSiblingMetadata {
  prev?: string;
  next?: string;
}

export interface SourceSpanMetadata extends SourceSpanSiblingMetadata {
  span_id: string;
  source_key: string;
  content_sha256: string;
  profile: SourceSpanProfile;
  sequence: number;
  anchor_ids: string[];
  speaker?: string;
  slide_number?: number;
  anchor_kind?: string;
  heading?: string;
  parent_label?: string;
}

export interface SourceSpanFrontmatter {
  type: "Source Span";
  title: string;
  description: string;
  contract_version: typeof SOURCE_SPAN_CONTRACT_VERSION;
  resource?: string;
  timestamp?: string;
  tags: string[];
  okv: SourceSpanMetadata;
}

export interface SourceSpanDocument {
  relativePath: string;
  frontmatter: SourceSpanFrontmatter;
  body: string;
}

export interface SourceSpanMetadataInput extends SourceSpanSiblingMetadata {
  sourceKey: string;
  contentSha256: string;
  profile: SourceSpanProfile;
  sequence: number;
  anchorIds: readonly string[];
  speaker?: string;
  slideNumber?: number;
  anchorKind?: string;
  heading?: string;
  parentLabel?: string;
}

export interface SourceSpanDocumentInput extends SourceSpanMetadataInput {
  title: string;
  description: string;
  body: string;
  resource?: string;
  timestamp?: string;
  tags?: readonly string[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_SOURCE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const SAFE_SPAN_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function assertContentSha256(contentSha256: string): void {
  if (!SHA256_PATTERN.test(contentSha256)) {
    throw new Error("contentSha256 must be a 64-character lowercase hex digest");
  }
}

function assertSequence(sequence: number): void {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("sequence must be a positive safe integer");
  }
}

function normalizeStringList(values: readonly string[], field: string): string[] {
  const normalized = values.map((value) => requireNonEmpty(value, field));
  return [...new Set(normalized)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function optionalString(value: string | undefined, field: string): string | undefined {
  return value === undefined ? undefined : requireNonEmpty(value, field);
}

function optionalSpanId(value: string | undefined, field: string): string | undefined {
  const spanId = optionalString(value, field);
  if (spanId !== undefined && !SAFE_SPAN_ID_PATTERN.test(spanId)) {
    throw new Error(`${field} must be a valid span ID`);
  }
  return spanId;
}

function slugBaseFromSourceKey(sourceKey: string): string {
  const identity = sourceKey.includes(":")
    ? sourceKey.slice(sourceKey.indexOf(":") + 1)
    : sourceKey;
  const pathParts = identity.replaceAll("\\", "/").split("/").filter(Boolean);
  const leaf = pathParts.at(-1) ?? identity;
  const withoutExtension = leaf.replace(/\.[a-z0-9]{1,10}$/iu, "");
  const slug = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : "source";
}

/**
 * Builds a readable, content-addressed namespace for one normalized source version.
 */
export function createSourceSpanSourceSlug(sourceKey: string, contentSha256: string): string {
  const normalizedSourceKey = requireNonEmpty(sourceKey, "sourceKey");
  assertContentSha256(contentSha256);
  const digest = createHash("sha256")
    .update(SOURCE_SPAN_CONTRACT_VERSION)
    .update("\0")
    .update(normalizedSourceKey)
    .update("\0")
    .update(contentSha256)
    .digest("hex")
    .slice(0, 12);
  return `${slugBaseFromSourceKey(normalizedSourceKey)}-${digest}`;
}

/**
 * Stable globally useful identity for a span. The visible filename remains span-XXX.md.
 */
export function createSourceSpanId(
  sourceKey: string,
  contentSha256: string,
  profile: SourceSpanProfile,
  sequence: number,
): string {
  const normalizedSourceKey = requireNonEmpty(sourceKey, "sourceKey");
  assertContentSha256(contentSha256);
  assertSequence(sequence);
  if (!(SOURCE_SPAN_PROFILES as readonly string[]).includes(profile)) {
    throw new Error(`Unsupported source span profile: ${String(profile)}`);
  }
  const digest = createHash("sha256")
    .update(SOURCE_SPAN_CONTRACT_VERSION)
    .update("\0")
    .update(normalizedSourceKey)
    .update("\0")
    .update(contentSha256)
    .update("\0")
    .update(profile)
    .update("\0")
    .update(String(sequence))
    .digest("hex")
    .slice(0, 16);
  return `span-${String(sequence).padStart(3, "0")}-${digest}`;
}

export function createSourceSpanFileName(sequence: number): string {
  assertSequence(sequence);
  return `span-${String(sequence).padStart(3, "0")}.md`;
}

export function createSourceSpanRelativePath(sourceSlug: string, sequence: number): string {
  if (!SAFE_SOURCE_SLUG_PATTERN.test(sourceSlug) || sourceSlug === "." || sourceSlug === "..") {
    throw new Error(`sourceSlug is not path-safe: ${sourceSlug}`);
  }
  const relativePath = posix.join(SOURCE_SPANS_DIR, sourceSlug, createSourceSpanFileName(sequence));
  if (posix.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new Error(`source span path is not vault-relative: ${relativePath}`);
  }
  return relativePath;
}

/** Returns the bounded previous/next links for one item in an ordered span ID list. */
export function createSourceSpanSiblingMetadata(
  spanIds: readonly string[],
  index: number,
): SourceSpanSiblingMetadata {
  if (!Number.isSafeInteger(index) || index < 0 || index >= spanIds.length) {
    throw new Error("index must identify an item in spanIds");
  }
  if (new Set(spanIds).size !== spanIds.length) {
    throw new Error("spanIds must be unique");
  }
  for (const spanId of spanIds) {
    if (!SAFE_SPAN_ID_PATTERN.test(spanId)) {
      throw new Error(`spanId is invalid: ${spanId}`);
    }
  }

  const prev = index > 0 ? spanIds[index - 1] : undefined;
  const next = index + 1 < spanIds.length ? spanIds[index + 1] : undefined;
  return {
    ...(prev !== undefined ? { prev } : {}),
    ...(next !== undefined ? { next } : {}),
  };
}

export function createSourceSpanMetadata(input: SourceSpanMetadataInput): SourceSpanMetadata {
  const sourceKey = requireNonEmpty(input.sourceKey, "sourceKey");
  assertContentSha256(input.contentSha256);
  assertSequence(input.sequence);
  if (!(SOURCE_SPAN_PROFILES as readonly string[]).includes(input.profile)) {
    throw new Error(`Unsupported source span profile: ${String(input.profile)}`);
  }
  if (
    input.slideNumber !== undefined &&
    (!Number.isSafeInteger(input.slideNumber) || input.slideNumber < 1)
  ) {
    throw new Error("slideNumber must be a positive safe integer");
  }

  const prev = optionalSpanId(input.prev, "prev");
  const next = optionalSpanId(input.next, "next");
  const speaker = optionalString(input.speaker, "speaker");
  const anchorKind = optionalString(input.anchorKind, "anchorKind");
  const heading = optionalString(input.heading, "heading");
  const parentLabel = optionalString(input.parentLabel, "parentLabel");

  return {
    span_id: createSourceSpanId(sourceKey, input.contentSha256, input.profile, input.sequence),
    source_key: sourceKey,
    content_sha256: input.contentSha256,
    profile: input.profile,
    sequence: input.sequence,
    anchor_ids: normalizeStringList(input.anchorIds, "anchorIds"),
    ...(prev !== undefined ? { prev } : {}),
    ...(next !== undefined ? { next } : {}),
    ...(speaker !== undefined ? { speaker } : {}),
    ...(input.slideNumber !== undefined ? { slide_number: input.slideNumber } : {}),
    ...(anchorKind !== undefined ? { anchor_kind: anchorKind } : {}),
    ...(heading !== undefined ? { heading } : {}),
    ...(parentLabel !== undefined ? { parent_label: parentLabel } : {}),
  };
}

function normalizeBody(body: string): string {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  while (lines.length > 0 && lines[0]!.trim().length === 0) {
    lines.shift();
  }
  while (lines.length > 0 && lines.at(-1)!.trim().length === 0) {
    lines.pop();
  }
  const normalized = lines.join("\n");
  if (normalized.trim().length === 0) {
    throw new Error("body must be non-empty");
  }
  return normalized;
}

export function createSourceSpanDocument(input: SourceSpanDocumentInput): SourceSpanDocument {
  const metadata = createSourceSpanMetadata(input);
  const sourceSlug = createSourceSpanSourceSlug(metadata.source_key, metadata.content_sha256);
  const resource = optionalString(input.resource, "resource");
  const timestamp = optionalString(input.timestamp, "timestamp");
  const tags = normalizeStringList(input.tags ?? ["source-span", input.profile], "tags");

  return {
    relativePath: createSourceSpanRelativePath(sourceSlug, metadata.sequence),
    frontmatter: {
      type: "Source Span",
      title: requireNonEmpty(input.title, "title"),
      description: requireNonEmpty(input.description, "description"),
      contract_version: SOURCE_SPAN_CONTRACT_VERSION,
      ...(resource !== undefined ? { resource } : {}),
      ...(timestamp !== undefined ? { timestamp } : {}),
      tags,
      okv: metadata,
    },
    body: normalizeBody(input.body),
  };
}

export function renderSourceSpanMarkdown(document: SourceSpanDocument): string {
  const frontmatter = stringifyYaml(document.frontmatter, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  });
  return `---\n${frontmatter}---\n\n${normalizeBody(document.body)}\n`;
}
