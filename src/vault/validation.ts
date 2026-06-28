import * as fs from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { parse as parseYaml } from "yaml";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import { NOTE_CONTRACT_VERSION } from "./constants.js";
import { deriveSourceKey, loadManifest } from "./manifest.js";

export const VALIDATION_REPORT_SCHEMA_VERSION = "okf-vault-validation-report/1.0.0" as const;
export const SOURCE_ENVELOPE_VERSION = "okf-source-envelope/1.0.0" as const;

export const SOURCE_NOTE_TYPES = [
  "Article Note",
  "Slide Deck Note",
  "Panel Transcript Note",
  "Video Transcript Note",
] as const;

export type SourceNoteType = (typeof SOURCE_NOTE_TYPES)[number];

export const MANDATORY_SECTIONS = [
  "# Summary",
  "# Key Claims",
  "# Citations",
  "# Evidence",
] as const;
export const DECK_SECTIONS = ["# Narrative", "# Slide Coverage"] as const;

export const ALLOWED_FRONTMATTER_KEYS = new Set([
  "type",
  "title",
  "description",
  "contract_version",
  "source",
  "tags",
  "resource",
  "timestamp",
  "claims",
]);

export const ALLOWED_SOURCE_KEYS = new Set([
  "source_key",
  "kind",
  "origin",
  "content_sha256",
  "acquired_at",
]);

export const ALLOWED_CLAIM_KEYS = new Set(["id", "text", "anchors"]);

export const CREDENTIAL_FIELD_PATTERN = /(?:^|_)(token|api_key|password|secret|credential)(?:$|_)/i;

export const CLAIM_ID_PATTERN = /^claim-\d{3}$/;
export const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ValidationReport {
  schema_version: typeof VALIDATION_REPORT_SCHEMA_VERSION;
  contract_version: string;
  status: "pass" | "fail";
  summary: string;
  issues: ValidationIssue[];
}

export interface SourceAnchor {
  id: string;
  kind: string;
  label?: string;
  text?: string;
  slide_number?: number;
  timestamp?: string;
  speaker?: string;
}

export interface DeckSlide {
  number: number;
  title?: string;
  text: string;
  speaker_notes: string;
  image_available: boolean;
}

export const ENVELOPE_SOURCE_KINDS = ["local", "google_drive", "granola", "youtube"] as const;

export type EnvelopeSourceKind = (typeof ENVELOPE_SOURCE_KINDS)[number];

export interface SourceEnvelope {
  contract_version: string;
  source_key: string;
  kind: EnvelopeSourceKind;
  content_type: string;
  origin: string;
  canonical_uri: string;
  title: string;
  modified_at: string;
  content_sha256: string;
  normalized_text: string;
  anchors: SourceAnchor[];
  slides?: DeckSlide[];
  deck_complete?: boolean;
}

export interface ParsedNote {
  relativePath: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

const reportSchemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/validation-report.schema.json",
);

let reportValidator: ValidateFunction | undefined;

function getReportValidator(): ValidateFunction {
  if (reportValidator === undefined) {
    const Ajv2020 = Ajv2020Import as unknown as new (options?: object) => {
      compile: (schema: object) => ValidateFunction;
    };
    const addFormats = addFormatsImport as unknown as (ajv: InstanceType<typeof Ajv2020>) => void;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(reportSchemaPath, "utf8")) as object;
    reportValidator = ajv.compile(schema);
  }
  return reportValidator;
}

export function isVaultRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/")) {
    return false;
  }
  const segments = path.split(/[/\\]/);
  return segments.every((segment) => segment !== ".." && segment !== "");
}

export function validateValidationReport(report: ValidationReport): void {
  const validate = getReportValidator();
  if (!validate(report)) {
    const detail =
      validate.errors?.map((error: ErrorObject) => error.message).join("; ") ?? "invalid";
    throw new Error(`Validation report schema validation failed: ${detail}`);
  }
}

export function loadSourceEnvelope(envelopePath: string): SourceEnvelope {
  const raw = JSON.parse(fs.readFileSync(resolve(envelopePath), "utf8")) as SourceEnvelope;
  if (raw.contract_version !== SOURCE_ENVELOPE_VERSION) {
    throw new Error(`Unsupported envelope contract_version '${raw.contract_version}'`);
  }
  return raw;
}

function envelopeHasUsableTimestampAnchors(envelope: SourceEnvelope): boolean {
  return envelope.anchors.some(
    (anchor) =>
      anchor.kind === "timestamp" &&
      typeof anchor.timestamp === "string" &&
      anchor.timestamp.trim().length > 0,
  );
}

function validateYoutubeEnvelope(envelope: SourceEnvelope): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  try {
    const expectedKey = deriveSourceKey("youtube", envelope.origin);
    if (envelope.source_key !== expectedKey) {
      issues.push(
        issue(
          "ENVELOPE_SOURCE_KEY_MISMATCH",
          `Envelope source_key '${envelope.source_key}' does not match derived key '${expectedKey}'.`,
        ),
      );
    }
  } catch {
    issues.push(
      issue(
        "INVALID_YOUTUBE_ORIGIN",
        `Envelope origin '${envelope.origin}' is not a valid YouTube identity.`,
      ),
    );
  }

  if (!envelopeHasUsableTimestampAnchors(envelope)) {
    issues.push(
      issue("INCOMPLETE_TRANSCRIPT_TIMESTAMPS", "YouTube transcript requires timestamp anchors."),
    );
  }

  return issues;
}

export function validateSourceEnvelope(envelope: SourceEnvelope): ValidationIssue[] {
  if (!(ENVELOPE_SOURCE_KINDS as readonly string[]).includes(envelope.kind)) {
    return [
      issue("UNSUPPORTED_ENVELOPE_KIND", `Unsupported envelope kind '${String(envelope.kind)}'.`),
    ];
  }

  if (envelope.kind === "youtube") {
    return validateYoutubeEnvelope(envelope);
  }

  return [];
}

export function parseNoteContent(
  relativePath: string,
  content: string,
): ParsedNote | ValidationIssue[] {
  if (!isVaultRelativePath(relativePath)) {
    return [
      {
        code: "INVALID_STAGED_PATH",
        message: `Staged path must be vault-relative and traversal-safe: ${relativePath}`,
        path: relativePath,
      },
    ];
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(content);
  if (match === null) {
    return [
      {
        code: "MISSING_FRONTMATTER",
        message: "Note is missing YAML frontmatter delimiters.",
        path: relativePath,
      },
    ];
  }

  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch {
    return [
      {
        code: "INVALID_FRONTMATTER",
        message: "Frontmatter YAML could not be parsed.",
        path: relativePath,
      },
    ];
  }

  if (frontmatter === null || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    return [
      {
        code: "INVALID_FRONTMATTER",
        message: "Frontmatter must be a YAML mapping.",
        path: relativePath,
      },
    ];
  }

  return {
    relativePath,
    frontmatter: frontmatter as Record<string, unknown>,
    body: match[2] ?? "",
  };
}

function issue(code: string, message: string, path?: string): ValidationIssue {
  const entry: ValidationIssue = { code, message };
  if (path !== undefined) {
    entry.path = path;
  }
  return entry;
}

export function extractSection(body: string, heading: string): string | undefined {
  const lines = body.split(/\r?\n/u);
  const headingLine = heading.trim();
  let start = -1;

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.trim() === headingLine) {
      start = index + 1;
      break;
    }
  }

  if (start === -1) {
    return undefined;
  }

  const content: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^#\s/u.test(line)) {
      break;
    }
    content.push(line);
  }

  return content.join("\n").trim();
}

function hasSection(body: string, heading: string): boolean {
  const headingLine = heading.trim();
  return body.split(/\r?\n/u).some((line) => line.trim() === headingLine);
}

function findClaimReferences(text: string): string[] {
  const matches = text.matchAll(/\b(claim-\d{3})\b/g);
  return [...matches].map((entry) => entry[1] ?? "").filter((value) => value.length > 0);
}

function findCredentialFields(value: unknown, path = ""): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => findCredentialFields(item, `${path}[${index}]`));
  }
  if (typeof value === "object") {
    const hits: string[] = [];
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = path.length > 0 ? `${path}.${key}` : key;
      if (CREDENTIAL_FIELD_PATTERN.test(key)) {
        hits.push(nextPath);
      }
      hits.push(...findCredentialFields(nested, nextPath));
    }
    return hits;
  }
  return [];
}

function validateUnknownFrontmatterKeys(
  frontmatter: Record<string, unknown>,
  relativePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(frontmatter)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      issues.push(
        issue(
          "UNKNOWN_FRONTMATTER_FIELD",
          `Unknown frontmatter field '${key}' is not allowed.`,
          relativePath,
        ),
      );
    }
  }
  return issues;
}

function validateRequiredStringField(
  frontmatter: Record<string, unknown>,
  field: string,
  relativePath: string,
  code = "MISSING_REQUIRED_FIELD",
): ValidationIssue[] {
  const value = frontmatter[field];
  if (typeof value !== "string" || value.trim() === "") {
    return [issue(code, `Frontmatter field '${field}' must be a non-empty string.`, relativePath)];
  }
  return [];
}

function validateSourceBlock(
  frontmatter: Record<string, unknown>,
  envelope: SourceEnvelope,
  relativePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const source = frontmatter.source;
  if (source === undefined || typeof source !== "object" || Array.isArray(source)) {
    issues.push(
      issue("MISSING_REQUIRED_FIELD", "Frontmatter field 'source' is required.", relativePath),
    );
    return issues;
  }

  const sourceRecord = source as Record<string, unknown>;
  for (const key of Object.keys(sourceRecord)) {
    if (!ALLOWED_SOURCE_KEYS.has(key)) {
      issues.push(
        issue(
          "UNKNOWN_FRONTMATTER_FIELD",
          `Unknown source field '${key}' is not allowed.`,
          relativePath,
        ),
      );
    }
  }

  for (const field of ["source_key", "kind", "origin", "content_sha256", "acquired_at"]) {
    issues.push(...validateRequiredStringField(sourceRecord, field, relativePath));
  }

  const sourceKey = sourceRecord.source_key;
  if (typeof sourceKey === "string" && sourceKey !== envelope.source_key) {
    issues.push(
      issue(
        "SOURCE_MISMATCH",
        `Note source_key '${sourceKey}' does not match envelope source_key '${envelope.source_key}'.`,
        relativePath,
      ),
    );
  }

  const contentSha = sourceRecord.content_sha256;
  if (typeof contentSha === "string" && !SHA256_PATTERN.test(contentSha)) {
    issues.push(
      issue(
        "INVALID_SOURCE_FIELD",
        "source.content_sha256 must be a 64-character lowercase hex digest.",
        relativePath,
      ),
    );
  }

  return issues;
}

function validateClaimsBlock(
  frontmatter: Record<string, unknown>,
  body: string,
  envelope: SourceEnvelope,
  relativePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const claims = frontmatter.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    issues.push(
      issue("MISSING_REQUIRED_FIELD", "Frontmatter field 'claims' is required.", relativePath),
    );
    return issues;
  }

  const claimIds = new Set<string>();
  const anchorIds = new Set(envelope.anchors.map((entry) => entry.id));

  for (const [index, claim] of claims.entries()) {
    if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
      issues.push(
        issue("INVALID_CLAIM", `Claim at index ${index} must be an object.`, relativePath),
      );
      continue;
    }

    const claimRecord = claim as Record<string, unknown>;
    for (const key of Object.keys(claimRecord)) {
      if (!ALLOWED_CLAIM_KEYS.has(key)) {
        issues.push(
          issue(
            "UNKNOWN_FRONTMATTER_FIELD",
            `Unknown claim field '${key}' is not allowed.`,
            relativePath,
          ),
        );
      }
    }

    const claimId = claimRecord.id;
    if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) {
      issues.push(
        issue(
          "INVALID_CLAIM_ID",
          `Claim id at index ${index} must match claim-NNN format.`,
          relativePath,
        ),
      );
      continue;
    }

    if (claimIds.has(claimId)) {
      issues.push(issue("DUPLICATE_CLAIM_ID", `Duplicate claim id '${claimId}'.`, relativePath));
    }
    claimIds.add(claimId);

    const anchors = claimRecord.anchors;
    if (!Array.isArray(anchors) || anchors.length === 0) {
      issues.push(
        issue(
          "MISSING_CLAIM_ANCHORS",
          `Claim '${claimId}' must list at least one source anchor.`,
          relativePath,
        ),
      );
      continue;
    }

    for (const anchorId of anchors) {
      if (typeof anchorId !== "string") {
        issues.push(
          issue(
            "INVALID_CLAIM_ANCHOR",
            `Claim '${claimId}' contains a non-string anchor reference.`,
            relativePath,
          ),
        );
        continue;
      }
      if (!anchorIds.has(anchorId)) {
        issues.push(
          issue(
            "ANCHOR_RESOLUTION_FAILED",
            `Claim '${claimId}' references anchor '${anchorId}' that is not present in the source envelope.`,
            relativePath,
          ),
        );
      }
    }
  }

  const keyClaimsSection = extractSection(body, "# Key Claims");
  if (keyClaimsSection === undefined) {
    return issues;
  }

  const referencedClaims = findClaimReferences(keyClaimsSection);
  if (referencedClaims.length === 0) {
    issues.push(
      issue(
        "MISSING_CLAIM_ID",
        "# Key Claims must reference at least one claim-NNN identifier.",
        relativePath,
      ),
    );
  }

  for (const claimId of referencedClaims) {
    if (!claimIds.has(claimId)) {
      issues.push(
        issue(
          "UNRESOLVED_CLAIM",
          `# Key Claims references '${claimId}' that is not declared in frontmatter claims.`,
          relativePath,
        ),
      );
    }
  }

  return issues;
}

interface SlideCoverageEntry {
  slideNumber: number;
  status: "covered" | "partial" | "excluded";
}

function parseSlideCoverage(section: string): SlideCoverageEntry[] {
  const entries: SlideCoverageEntry[] = [];
  const lines = section.split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || (trimmed.startsWith("|") && trimmed.includes("---"))) {
      continue;
    }

    const slideMatch = /\b(\d+)\b/u.exec(trimmed);
    if (slideMatch === null) {
      continue;
    }

    const slideNumber = Number(slideMatch[1]);
    const lower = trimmed.toLowerCase();
    let status: SlideCoverageEntry["status"] | undefined;
    if (lower.includes("covered")) {
      status = "covered";
    } else if (lower.includes("partial")) {
      status = "partial";
    } else if (lower.includes("excluded")) {
      status = "excluded";
    }

    if (status !== undefined) {
      entries.push({ slideNumber, status });
    }
  }

  return entries;
}

function validateDeckCoverage(
  body: string,
  envelope: SourceEnvelope,
  relativePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const slides = envelope.slides ?? [];
  if (slides.length === 0) {
    issues.push(
      issue(
        "DECK_ENVELOPE_INCOMPLETE",
        "Slide deck envelope must include ordered slides for coverage validation.",
        relativePath,
      ),
    );
    return issues;
  }

  const coverageSection = extractSection(body, "# Slide Coverage");
  if (coverageSection === undefined) {
    return issues;
  }

  const parsed = parseSlideCoverage(coverageSection);
  const coveredNumbers = new Set(parsed.map((entry) => entry.slideNumber));
  const envelopeNumbers = slides.map((slide) => slide.number).sort((left, right) => left - right);

  const missingSlides = envelopeNumbers.filter((number) => !coveredNumbers.has(number));
  if (missingSlides.length > 0) {
    issues.push(
      issue(
        "DECK_COVERAGE_INCOMPLETE",
        `Slide coverage is incomplete; missing slide number(s): ${missingSlides.join(", ")}.`,
        relativePath,
      ),
    );
  }

  for (const entry of parsed) {
    if (!envelopeNumbers.includes(entry.slideNumber)) {
      issues.push(
        issue(
          "DECK_SLIDE_MISSING",
          `Slide coverage references slide ${entry.slideNumber} which is not present in the source envelope.`,
          relativePath,
        ),
      );
    }
  }

  const narrative = extractSection(body, "# Narrative") ?? "";
  const keyClaims = extractSection(body, "# Key Claims") ?? "";
  const combinedClaimsText = `${narrative}\n${keyClaims}`;

  for (const slide of slides) {
    if (slide.speaker_notes.trim().length === 0) {
      continue;
    }
    const speakerAnchor = envelope.anchors.find(
      (anchor) => anchor.kind === "speaker_note" && anchor.slide_number === slide.number,
    );
    if (speakerAnchor === undefined) {
      continue;
    }

    const speakerClaimIds = findClaimReferences(slide.speaker_notes);
    for (const claimId of speakerClaimIds) {
      if (combinedClaimsText.includes(claimId)) {
        const claimUsesSpeakerAnchor = envelope.anchors.some(
          (anchor) => anchor.id === speakerAnchor.id && anchor.kind === "speaker_note",
        );
        if (!claimUsesSpeakerAnchor) {
          issues.push(
            issue(
              "SPEAKER_NOTE_ANCHOR_MISSING",
              `Speaker-note claim '${claimId}' on slide ${slide.number} lacks a resolvable anchor.`,
              relativePath,
            ),
          );
        }
      }
    }
  }

  return issues;
}

function validateNoteStructure(
  note: ParsedNote,
  manifestContractVersion: string,
  envelope: SourceEnvelope,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { relativePath, frontmatter, body } = note;

  issues.push(...validateUnknownFrontmatterKeys(frontmatter, relativePath));

  const credentialHits = findCredentialFields(frontmatter);
  for (const hit of credentialHits) {
    issues.push(
      issue(
        "CREDENTIAL_FIELD",
        `Prohibited credential-like field '${hit}' is not allowed in managed notes.`,
        relativePath,
      ),
    );
  }

  issues.push(
    ...validateRequiredStringField(frontmatter, "type", relativePath, "MISSING_NOTE_TYPE"),
  );
  issues.push(...validateRequiredStringField(frontmatter, "title", relativePath));
  issues.push(...validateRequiredStringField(frontmatter, "description", relativePath));

  const contractVersion = frontmatter.contract_version;
  if (typeof contractVersion !== "string" || contractVersion.trim() === "") {
    issues.push(
      issue(
        "MISSING_REQUIRED_FIELD",
        "Frontmatter field 'contract_version' is required.",
        relativePath,
      ),
    );
  } else if (contractVersion !== manifestContractVersion) {
    issues.push(
      issue(
        "CONTRACT_VERSION_MISMATCH",
        `Note contract_version '${contractVersion}' does not match vault manifest '${manifestContractVersion}'.`,
        relativePath,
      ),
    );
  } else if (contractVersion !== NOTE_CONTRACT_VERSION) {
    issues.push(
      issue(
        "CONTRACT_VERSION_MISMATCH",
        `Unsupported note contract_version '${contractVersion}'.`,
        relativePath,
      ),
    );
  }

  const noteType = frontmatter.type;
  if (typeof noteType !== "string" || noteType.trim() === "") {
    return issues;
  }

  if (!(SOURCE_NOTE_TYPES as readonly string[]).includes(noteType)) {
    issues.push(
      issue("UNSUPPORTED_NOTE_TYPE", `Unsupported note type '${noteType}'.`, relativePath),
    );
    return issues;
  }

  for (const section of MANDATORY_SECTIONS) {
    if (!hasSection(body, section)) {
      issues.push(
        issue("MISSING_SECTION", `Required section '${section}' is missing.`, relativePath),
      );
    }
  }

  if (noteType === "Slide Deck Note") {
    for (const section of DECK_SECTIONS) {
      if (!hasSection(body, section)) {
        issues.push(
          issue("MISSING_SECTION", `Required section '${section}' is missing.`, relativePath),
        );
      }
    }
  }

  issues.push(...validateSourceBlock(frontmatter, envelope, relativePath));
  issues.push(...validateClaimsBlock(frontmatter, body, envelope, relativePath));

  if (noteType === "Slide Deck Note") {
    issues.push(...validateDeckCoverage(body, envelope, relativePath));
    issues.push(...validateDeckNarrativeClaims(frontmatter, body, envelope, relativePath));
  }

  return issues;
}

function validateDeckNarrativeClaims(
  frontmatter: Record<string, unknown>,
  body: string,
  envelope: SourceEnvelope,
  relativePath: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const narrative = extractSection(body, "# Narrative");
  if (narrative === undefined) {
    return issues;
  }

  const claims = Array.isArray(frontmatter.claims) ? frontmatter.claims : [];
  const narrativeClaimIds = findClaimReferences(narrative);

  for (const claimId of narrativeClaimIds) {
    const claim = claims.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        (entry as Record<string, unknown>).id === claimId,
    ) as Record<string, unknown> | undefined;

    const anchorIds = Array.isArray(claim?.anchors)
      ? claim.anchors.filter((value): value is string => typeof value === "string")
      : [];

    const hasSlideOrSpeakerAnchor = anchorIds.some((anchorId) => {
      const anchor = envelope.anchors.find((entry) => entry.id === anchorId);
      return anchor?.kind === "slide" || anchor?.kind === "speaker_note";
    });

    if (!hasSlideOrSpeakerAnchor) {
      issues.push(
        issue(
          "DECK_NARRATIVE_ANCHOR_MISSING",
          `Narrative claim '${claimId}' lacks a corresponding slide or speaker-note anchor.`,
          relativePath,
        ),
      );
    }
  }

  return issues;
}

function collectStagedNotes(stagingRoot: string): {
  notes: ParsedNote[];
  issues: ValidationIssue[];
} {
  const notes: ParsedNote[] = [];
  const issues: ValidationIssue[] = [];
  const resolvedStaging = resolve(stagingRoot);

  function walk(currentDir: string): void {
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const relativePath = relative(resolvedStaging, fullPath).split("\\").join("/");
      if (!isVaultRelativePath(relativePath)) {
        issues.push(
          issue(
            "INVALID_STAGED_PATH",
            `Staged path must be vault-relative and traversal-safe: ${relativePath}`,
            relativePath,
          ),
        );
        continue;
      }

      const content = fs.readFileSync(fullPath, "utf8");
      const parsed = parseNoteContent(relativePath, content);
      if (Array.isArray(parsed)) {
        issues.push(...parsed);
        continue;
      }
      notes.push(parsed);
    }
  }

  if (!fs.existsSync(resolvedStaging)) {
    issues.push(issue("STAGING_NOT_FOUND", `Staging directory does not exist: ${resolvedStaging}`));
    return { notes, issues };
  }

  walk(resolvedStaging);
  return { notes, issues };
}

export function buildValidationReport(
  contractVersion: string,
  issues: ValidationIssue[],
): ValidationReport {
  const status = issues.length === 0 ? "pass" : "fail";
  const summary =
    status === "pass"
      ? "All staged notes passed note-contract validation."
      : `${issues.length} validation issue(s) found in staged output.`;

  const report: ValidationReport = {
    schema_version: VALIDATION_REPORT_SCHEMA_VERSION,
    contract_version: contractVersion,
    status,
    summary,
    issues,
  };

  validateValidationReport(report);
  return report;
}

export interface ValidateStagedResult {
  report: ValidationReport;
  staged_paths: string[];
}

export function validateStagedNotes(
  vaultRoot: string,
  stagingDir: string,
  envelope: SourceEnvelope,
): ValidateStagedResult {
  const manifest = loadManifest(vaultRoot);
  const { notes, issues: stagingIssues } = collectStagedNotes(stagingDir);
  const issues = [...stagingIssues, ...validateSourceEnvelope(envelope)];

  if (notes.length === 0 && stagingIssues.length === 0) {
    issues.push(issue("STAGING_EMPTY", "No staged Markdown notes were found for validation."));
  }

  for (const note of notes) {
    issues.push(...validateNoteStructure(note, manifest.note_contract_version, envelope));
  }

  const report = buildValidationReport(manifest.note_contract_version, issues);
  return {
    report,
    staged_paths: notes.map((note) => note.relativePath),
  };
}

/** Structural validation for committed notes at quality-gate time (no envelope anchors). */
export function validateCommittedNoteAtRest(
  note: ParsedNote,
  manifestContractVersion: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const { relativePath, frontmatter, body } = note;

  issues.push(...validateUnknownFrontmatterKeys(frontmatter, relativePath));

  const credentialHits = findCredentialFields(frontmatter);
  for (const hit of credentialHits) {
    issues.push(
      issue(
        "CREDENTIAL_FIELD",
        `Prohibited credential-like field '${hit}' is not allowed in managed notes.`,
        relativePath,
      ),
    );
  }

  issues.push(
    ...validateRequiredStringField(frontmatter, "type", relativePath, "MISSING_NOTE_TYPE"),
  );
  issues.push(...validateRequiredStringField(frontmatter, "title", relativePath));
  issues.push(...validateRequiredStringField(frontmatter, "description", relativePath));

  const contractVersion = frontmatter.contract_version;
  if (typeof contractVersion !== "string" || contractVersion.trim() === "") {
    issues.push(
      issue(
        "MISSING_REQUIRED_FIELD",
        "Frontmatter field 'contract_version' is required.",
        relativePath,
      ),
    );
  } else if (contractVersion !== manifestContractVersion) {
    issues.push(
      issue(
        "CONTRACT_VERSION_MISMATCH",
        `Note contract_version '${contractVersion}' does not match vault manifest '${manifestContractVersion}'.`,
        relativePath,
      ),
    );
  } else if (contractVersion !== NOTE_CONTRACT_VERSION) {
    issues.push(
      issue(
        "CONTRACT_VERSION_MISMATCH",
        `Unsupported note contract_version '${contractVersion}'.`,
        relativePath,
      ),
    );
  }

  const noteType = frontmatter.type;
  if (typeof noteType !== "string" || noteType.trim() === "") {
    return issues;
  }

  if (!(SOURCE_NOTE_TYPES as readonly string[]).includes(noteType)) {
    issues.push(
      issue("UNSUPPORTED_NOTE_TYPE", `Unsupported note type '${noteType}'.`, relativePath),
    );
    return issues;
  }

  for (const section of MANDATORY_SECTIONS) {
    if (!hasSection(body, section)) {
      issues.push(
        issue("MISSING_SECTION", `Required section '${section}' is missing.`, relativePath),
      );
    }
  }

  if (noteType === "Slide Deck Note") {
    for (const section of DECK_SECTIONS) {
      if (!hasSection(body, section)) {
        issues.push(
          issue("MISSING_SECTION", `Required section '${section}' is missing.`, relativePath),
        );
      }
    }
  }

  const source = frontmatter.source;
  if (source === undefined || typeof source !== "object" || Array.isArray(source)) {
    issues.push(
      issue("MISSING_REQUIRED_FIELD", "Frontmatter field 'source' is required.", relativePath),
    );
  } else {
    const sourceRecord = source as Record<string, unknown>;
    for (const field of ["source_key", "kind", "origin", "content_sha256", "acquired_at"]) {
      issues.push(...validateRequiredStringField(sourceRecord, field, relativePath));
    }
  }

  const claims = frontmatter.claims;
  if (!Array.isArray(claims) || claims.length === 0) {
    issues.push(
      issue("MISSING_REQUIRED_FIELD", "Frontmatter field 'claims' is required.", relativePath),
    );
  } else {
    const claimIds = new Set<string>();
    for (const [index, claim] of claims.entries()) {
      if (typeof claim !== "object" || claim === null || Array.isArray(claim)) {
        issues.push(
          issue("INVALID_CLAIM", `Claim at index ${index} must be an object.`, relativePath),
        );
        continue;
      }
      const claimRecord = claim as Record<string, unknown>;
      const claimId = claimRecord.id;
      if (typeof claimId !== "string" || !CLAIM_ID_PATTERN.test(claimId)) {
        issues.push(
          issue(
            "INVALID_CLAIM_ID",
            `Claim id at index ${index} must match claim-NNN format.`,
            relativePath,
          ),
        );
        continue;
      }
      if (claimIds.has(claimId)) {
        issues.push(issue("DUPLICATE_CLAIM_ID", `Duplicate claim id '${claimId}'.`, relativePath));
      }
      claimIds.add(claimId);
    }

    const keyClaimsSection = extractSection(body, "# Key Claims");
    if (keyClaimsSection !== undefined) {
      const referencedClaims = findClaimReferences(keyClaimsSection);
      for (const claimId of referencedClaims) {
        if (!claimIds.has(claimId)) {
          issues.push(
            issue(
              "UNRESOLVED_CLAIM",
              `# Key Claims references '${claimId}' that is not declared in frontmatter claims.`,
              relativePath,
            ),
          );
        }
      }
    }
  }

  return issues;
}

export function validateCommittedNotes(vaultRoot: string): ValidationIssue[] {
  const manifest = loadManifest(vaultRoot);
  const issues: ValidationIssue[] = [];
  const root = resolve(vaultRoot);

  for (const record of manifest.sources) {
    if (record.status !== "committed" || record.note_path === undefined) {
      continue;
    }
    const absolutePath = join(root, record.note_path);
    if (!fs.existsSync(absolutePath)) {
      continue;
    }
    const content = fs.readFileSync(absolutePath, "utf8");
    const parsed = parseNoteContent(record.note_path, content);
    if (Array.isArray(parsed)) {
      issues.push(...parsed);
      continue;
    }
    issues.push(...validateCommittedNoteAtRest(parsed, manifest.note_contract_version));
  }

  return issues;
}

export function handleValidateStaged(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  const stagingDir = args[1];
  const envelopePath = args[2];

  if (vaultRoot === undefined || stagingDir === undefined || envelopePath === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "validate-staged",
        "USAGE_MISSING_ARGS",
        "Usage: validate-staged <vault-root> <staging-dir> <envelope-json-path>",
      ),
      diagnostic: "Missing required arguments for validate-staged.",
    };
  }

  try {
    const envelope = loadSourceEnvelope(envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    const exitCode = result.report.status === "pass" ? ExitCode.SUCCESS : ExitCode.VALIDATION;

    return {
      exitCode,
      result: success("validate-staged", {
        ...result.report,
        staged_paths: result.staged_paths,
      }),
      ...(exitCode === ExitCode.VALIDATION ? { diagnostic: result.report.summary } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Staged validation failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("validate-staged", "VALIDATE_STAGED_FAILED", message),
      diagnostic: message,
    };
  }
}
