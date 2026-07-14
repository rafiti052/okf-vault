import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli/cli.js";
import { initializeVault, type SourceSpanProfile } from "../../dist/vault/manifest.js";
import { MANIFEST_RELATIVE_PATH, NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import { generateArticleSpanDocuments } from "../../dist/vault/source-spans-article.js";
import { generateDeckSourceSpans } from "../../dist/vault/source-spans-deck.js";
import { generatePanelSourceSpans } from "../../dist/vault/source-spans-panel.js";
import { generateVideoSourceSpans } from "../../dist/vault/source-spans-video.js";
import {
  renderSourceSpanMarkdown,
  type SourceSpanDocument,
} from "../../dist/vault/source-spans.js";
import {
  SOURCE_SPAN_VALIDATION_CODES,
  buildValidationReport,
  isVaultRelativePath,
  loadSourceEnvelope,
  parseNoteContent,
  validateSourceEnvelope,
  validateStagedNotes,
  validateValidationReport,
  type SourceEnvelope,
  type ValidationReport,
} from "../../dist/vault/validation.js";
import { youtubeAccepted, youtubeRejected } from "../fixtures/youtube-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const fixturesDir = join(root, "test", "fixtures");
const notesDir = join(fixturesDir, "notes");
const envelopesDir = join(fixturesDir, "envelopes");

function loadEnvelope(name: string) {
  return loadSourceEnvelope(join(envelopesDir, name));
}

function stageNote(
  vaultRoot: string,
  runId: string,
  fixtureName: string,
  stagedName = "notes/staged-note.md",
) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(stagedName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(notesDir, fixtureName), join(stagingDir, stagedName));
  return stagingDir;
}

function stageArticleSourceSpans(
  stagingDir: string,
  envelope: ReturnType<typeof loadSourceEnvelope>,
): string[] {
  return stageSourceSpanDocuments(stagingDir, generateArticleSpanDocuments(envelope));
}

function stageSourceSpanDocuments(
  stagingDir: string,
  documents: readonly SourceSpanDocument[],
): string[] {
  return documents.map((document) => {
    const target = join(stagingDir, document.relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, renderSourceSpanMarkdown(document), "utf8");
    return document.relativePath;
  });
}

function generatedSourceSpans(
  profile: SourceSpanProfile,
  envelope: SourceEnvelope,
): SourceSpanDocument[] {
  switch (profile) {
    case "article":
      return generateArticleSpanDocuments(envelope);
    case "video":
      return generateVideoSourceSpans(envelope);
    case "panel":
      return generatePanelSourceSpans(envelope);
    case "deck":
      return generateDeckSourceSpans(envelope);
  }
}

function stageGoldNote(vaultRoot: string, runId: string, notePath: string, stagedName: string) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(stagedName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(notePath, join(stagingDir, stagedName));
  return stagingDir;
}

describe("vault-relative path safety", () => {
  it("accepts valid relative paths and rejects absolute or traversal paths", () => {
    assert.equal(isVaultRelativePath("notes/example.md"), true);
    assert.equal(isVaultRelativePath("../notes/evil.md"), false);
    assert.equal(isVaultRelativePath("/tmp/note.md"), false);
  });

  it("rejects unsafe staged paths before file read during parsing", () => {
    const evil = parseNoteContent("../notes/evil.md", "# no frontmatter");
    assert.ok(Array.isArray(evil));
    if (Array.isArray(evil)) {
      assert.equal(evil[0]?.code, "INVALID_STAGED_PATH");
    }

    const absolute = parseNoteContent("/tmp/note.md", "# no frontmatter");
    assert.ok(Array.isArray(absolute));
    if (Array.isArray(absolute)) {
      assert.equal(absolute[0]?.code, "INVALID_STAGED_PATH");
    }
  });
});

describe("validation report schema", () => {
  it("accepts a complete pass report and rejects missing status or invalid codes", () => {
    const report: ValidationReport = {
      schema_version: "okf-vault-validation-report/1.0.0",
      contract_version: NOTE_CONTRACT_VERSION,
      status: "pass",
      summary: "All checks passed.",
      issues: [],
    };
    assert.doesNotThrow(() => validateValidationReport(report));

    assert.throws(() =>
      validateValidationReport({
        ...report,
        status: undefined as unknown as "pass",
      }),
    );

    assert.throws(() =>
      buildValidationReport(NOTE_CONTRACT_VERSION, [{ code: "bad", message: "lower case code" }]),
    );
  });
});

describe("source envelope validation", () => {
  it("loads and accepts a valid YouTube transcript envelope with timestamp anchors", () => {
    const envelope = loadSourceEnvelope(youtubeAccepted.envelopePath);
    assert.equal(envelope.kind, "youtube");
    const issues = validateSourceEnvelope(envelope);
    assert.equal(issues.length, 0);
  });

  it("rejects a YouTube transcript envelope missing timestamp anchors", () => {
    const envelope = loadSourceEnvelope(youtubeRejected.envelopePath);
    const issues = validateSourceEnvelope(envelope);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, "INCOMPLETE_TRANSCRIPT_TIMESTAMPS");
    assert.match(issues[0]?.message ?? "", /timestamp anchors/i);
  });

  it("continues validating local, Drive, and Granola transcript envelopes unchanged", () => {
    for (const name of [
      "article-local.json",
      "google-drive-article.json",
      "panel-transcript.json",
      "video-transcript.json",
    ]) {
      const envelope = loadEnvelope(name);
      const issues = validateSourceEnvelope(envelope);
      assert.equal(issues.length, 0, `${name} should pass envelope validation`);
    }
  });

  it("rejects timestamp anchors with empty timestamp values on YouTube envelopes", () => {
    const envelope = loadSourceEnvelope(youtubeAccepted.envelopePath);
    envelope.anchors = [
      {
        id: "timestamp-empty",
        kind: "timestamp",
        label: "Empty",
        text: "No time value.",
        timestamp: "   ",
      },
    ];
    const issues = validateSourceEnvelope(envelope);
    assert.ok(issues.some((entry) => entry.code === "INCOMPLETE_TRANSCRIPT_TIMESTAMPS"));
  });
});

describe("staged note contract validation", () => {
  it("passes a valid Article Note fixture with required sections, claim IDs, and anchors", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-article-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-article", "article-valid.md");
    const envelope = loadEnvelope("article-local.json");
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
    assert.equal(result.report.issues.length, 0);
    assert.equal(result.report.summary, "All staged notes passed note-contract validation.");
    assert.deepEqual(result.source_span_paths, []);
    assert.equal(result.source_span_count, 0);
    assert.equal(result.source_profile, undefined);
  });

  it("passes generated source spans and reports their staged profile and paths", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-article-spans-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-article-spans", "article-valid.md");
    const envelope = loadEnvelope("article-local.json");
    const sourceSpanPaths = stageArticleSourceSpans(stagingDir, envelope);

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);

    assert.equal(result.report.status, "pass");
    assert.equal(result.report.summary, "All staged notes and source spans passed validation.");
    assert.deepEqual(result.report.issues, []);
    assert.equal(result.source_profile, "article");
    assert.equal(result.source_span_count, sourceSpanPaths.length);
    assert.deepEqual(result.source_span_paths, sourceSpanPaths);
    assert.deepEqual(result.staged_paths, ["notes/staged-note.md"]);
  });

  it("surfaces source-span issue codes for malformed staged span output", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-bad-spans-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-bad-spans", "article-valid.md");
    const envelope = loadEnvelope("article-local.json");
    const [sourceSpanPath] = stageArticleSourceSpans(stagingDir, envelope);
    assert.ok(sourceSpanPath);
    writeFileSync(join(stagingDir, sourceSpanPath), "tampered staged span\n", { flag: "a" });

    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);

    assert.equal(result.report.status, "fail");
    assert.ok(
      result.report.issues.some(
        (entry) => entry.code === SOURCE_SPAN_VALIDATION_CODES.hashMismatch,
      ),
    );
    assert.equal(result.source_span_count, 1);
    assert.equal(result.source_profile, "article");
  });

  it("passes staged source spans for every supported source-note profile", () => {
    const cases: Array<{
      profile: SourceSpanProfile;
      note: string;
      envelope: string;
    }> = [
      { profile: "article", note: "article-valid.md", envelope: "article-local.json" },
      { profile: "video", note: "video-valid.md", envelope: "video-transcript.json" },
      { profile: "panel", note: "panel-valid.md", envelope: "panel-transcript.json" },
      { profile: "deck", note: "deck-valid.md", envelope: "deck-five-slides.json" },
    ];

    for (const testCase of cases) {
      const vaultRoot = mkdtempSync(join(tmpdir(), `okf-validate-${testCase.profile}-spans-`));
      initializeVault(vaultRoot);
      const stagingDir = stageNote(vaultRoot, `run-${testCase.profile}-spans`, testCase.note);
      const envelope = loadEnvelope(testCase.envelope);
      const sourceSpanPaths = stageSourceSpanDocuments(
        stagingDir,
        generatedSourceSpans(testCase.profile, envelope),
      );

      const result = validateStagedNotes(vaultRoot, stagingDir, envelope);

      assert.equal(result.report.status, "pass", `${testCase.profile} spans should pass`);
      assert.equal(result.source_profile, testCase.profile);
      assert.equal(result.source_span_count, sourceSpanPaths.length);
      assert.deepEqual(result.source_span_paths, sourceSpanPaths);
    }
  });

  it("rejects staging directories outside the vault tmp directory", () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "okf-validate-outside-parent-"));
    const vaultRoot = join(parentRoot, "knowledge");
    initializeVault(vaultRoot);
    const outsideStagingDir = join(dirname(vaultRoot), ".okf-vault", "tmp", "run-outside");
    const targetDir = join(outsideStagingDir, "notes");
    mkdirSync(targetDir, { recursive: true });
    copyFileSync(join(notesDir, "article-valid.md"), join(targetDir, "staged-note.md"));
    const envelope = loadEnvelope("article-local.json");

    const result = validateStagedNotes(vaultRoot, outsideStagingDir, envelope);

    assert.equal(result.report.status, "fail");
    assert.ok(result.report.issues.some((entry) => entry.code === "STAGING_OUTSIDE_VAULT_TMP"));
    assert.deepEqual(result.staged_paths, []);
  });

  it("rejects staging paths that escape through a symlink", () => {
    const parentRoot = mkdtempSync(join(tmpdir(), "okf-validate-symlink-parent-"));
    const vaultRoot = join(parentRoot, "knowledge");
    initializeVault(vaultRoot);
    const outsideRoot = join(parentRoot, "outside");
    const outsideStagingDir = join(outsideRoot, "run-symlink");
    mkdirSync(outsideStagingDir, { recursive: true });
    copyFileSync(join(notesDir, "article-valid.md"), join(outsideStagingDir, "staged-note.md"));
    const linkedStagingDir = join(vaultRoot, ".okf-vault", "tmp", "run-symlink");
    symlinkSync(outsideStagingDir, linkedStagingDir, "dir");
    const envelope = loadEnvelope("article-local.json");

    const result = validateStagedNotes(vaultRoot, linkedStagingDir, envelope);

    assert.equal(result.report.status, "fail");
    assert.ok(result.report.issues.some((entry) => entry.code === "STAGING_OUTSIDE_VAULT_TMP"));
    assert.deepEqual(result.staged_paths, []);
  });

  it("returns structural error codes for missing sections, empty type, or unsupported note type", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-struct-"));
    initializeVault(vaultRoot);
    const envelope = loadEnvelope("article-local.json");

    const missingSectionDir = stageNote(vaultRoot, "run-missing", "article-missing-sections.md");
    const missingSection = validateStagedNotes(vaultRoot, missingSectionDir, envelope);
    assert.equal(missingSection.report.status, "fail");
    assert.ok(missingSection.report.issues.some((entry) => entry.code === "MISSING_SECTION"));

    const emptyTypeDir = stageNote(vaultRoot, "run-empty-type", "article-bad-type.md");
    const emptyType = validateStagedNotes(vaultRoot, emptyTypeDir, envelope);
    assert.ok(emptyType.report.issues.some((entry) => entry.code === "MISSING_NOTE_TYPE"));

    const panelDir = stageNote(vaultRoot, "run-panel-type", "panel-invalid-type.md");
    const panelEnvelope = loadEnvelope("panel-transcript.json");
    const unsupported = validateStagedNotes(vaultRoot, panelDir, panelEnvelope);
    assert.ok(unsupported.report.issues.some((entry) => entry.code === "UNSUPPORTED_NOTE_TYPE"));
  });

  it("fails anchor resolution for claim-007 without a matching envelope anchor", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-anchor-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-anchor", "article-unresolved-claim.md");
    const envelope = loadEnvelope("article-local.json");
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const anchorIssue = result.report.issues.find(
      (entry) => entry.code === "ANCHOR_RESOLUTION_FAILED",
    );
    assert.ok(anchorIssue);
    assert.match(anchorIssue.message, /claim-007/);
  });

  it("fails deck coverage when slide 3 is omitted from a five-slide envelope", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-deck-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-deck", "deck-missing-slide-coverage.md");
    const envelope = loadEnvelope("deck-five-slides.json");
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const coverageIssue = result.report.issues.find(
      (entry) => entry.code === "DECK_COVERAGE_INCOMPLETE",
    );
    assert.ok(coverageIssue);
    assert.match(coverageIssue.message, /3/);
  });

  it("fails deck narrative claims that lack slide or speaker-note anchors", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-narrative-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-narrative", "deck-narrative-missing-anchor.md");
    const envelope = loadEnvelope("deck-five-slides.json");
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    assert.ok(
      result.report.issues.some(
        (entry) =>
          entry.code === "DECK_NARRATIVE_ANCHOR_MISSING" && /claim-003/.test(entry.message),
      ),
    );
  });

  it("validates every source-note type with passing and failing fixtures", () => {
    const cases = [
      {
        valid: "panel-valid.md",
        invalid: "panel-invalid-type.md",
        envelope: "panel-transcript.json",
      },
      {
        valid: "video-valid.md",
        invalid: "video-missing-evidence.md",
        envelope: "video-transcript.json",
      },
      {
        valid: "deck-valid.md",
        invalid: "deck-missing-slide-coverage.md",
        envelope: "deck-five-slides.json",
      },
      {
        valid: "article-valid.md",
        invalid: "article-missing-sections.md",
        envelope: "article-local.json",
      },
    ];

    for (const testCase of cases) {
      const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-types-"));
      initializeVault(vaultRoot);
      const envelope = loadEnvelope(testCase.envelope);

      const validDir = stageNote(vaultRoot, "run-valid", testCase.valid);
      const valid = validateStagedNotes(vaultRoot, validDir, envelope);
      assert.equal(valid.report.status, "pass", `${testCase.valid} should pass`);

      const invalidDir = stageNote(vaultRoot, "run-invalid", testCase.invalid);
      const invalid = validateStagedNotes(vaultRoot, invalidDir, envelope);
      assert.equal(invalid.report.status, "fail", `${testCase.invalid} should fail`);
    }
  });

  it("accepts a valid MVP YouTube transcript note and envelope pair", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-youtube-pass-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(
      vaultRoot,
      "run-youtube",
      youtubeAccepted.notePath,
      youtubeAccepted.stagedNotePath,
    );
    const envelope = loadSourceEnvelope(youtubeAccepted.envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "pass");
    assert.equal(result.report.issues.length, 0);
  });

  it("fails staged validation before commit when YouTube envelope lacks timestamps", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-youtube-fail-"));
    initializeVault(vaultRoot);
    const stagingDir = stageGoldNote(
      vaultRoot,
      "run-youtube-bad",
      youtubeAccepted.notePath,
      youtubeAccepted.stagedNotePath,
    );
    const envelope = loadSourceEnvelope(youtubeRejected.envelopePath);
    const result = validateStagedNotes(vaultRoot, stagingDir, envelope);
    assert.equal(result.report.status, "fail");
    const timestampIssue = result.report.issues.find(
      (entry) => entry.code === "INCOMPLETE_TRANSCRIPT_TIMESTAMPS",
    );
    assert.ok(timestampIssue);
    assert.match(timestampIssue?.message ?? "", /timestamp anchors/i);
  });
});

describe("staged validation edge cases", () => {
  it("rejects unknown frontmatter, malformed YAML, and envelope version mismatches", () => {
    const badEnvelopePath = join(tmpdir(), "bad-envelope.json");
    writeFileSync(
      badEnvelopePath,
      JSON.stringify({
        contract_version: "okf-source-envelope/9.9.9",
        source_key: "local:/tmp/x",
        kind: "local",
        content_type: "text/plain",
        origin: "/tmp/x",
        canonical_uri: "file:///tmp/x",
        title: "x",
        modified_at: "2026-06-19T12:00:00.000Z",
        content_sha256: "a".repeat(64),
        normalized_text: "x",
        anchors: [],
      }),
      "utf8",
    );
    assert.throws(
      () => loadSourceEnvelope(badEnvelopePath),
      /Unsupported envelope contract_version/,
    );

    const invalidYaml = parseNoteContent("notes/bad.md", "---\n[[[\n---\n# Summary\n");
    assert.ok(Array.isArray(invalidYaml));

    const missingFm = parseNoteContent("notes/bad.md", "# no frontmatter");
    assert.ok(Array.isArray(missingFm));
    if (Array.isArray(missingFm)) {
      assert.equal(missingFm[0]?.code, "MISSING_FRONTMATTER");
    }
  });

  it("reports staging directory and empty staging failures", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-staging-"));
    initializeVault(vaultRoot);
    const envelope = loadEnvelope("article-local.json");

    const outside = validateStagedNotes(vaultRoot, join(vaultRoot, "missing-staging"), envelope);
    assert.equal(outside.report.status, "fail");
    assert.ok(outside.report.issues.some((entry) => entry.code === "STAGING_OUTSIDE_VAULT_TMP"));

    const missing = validateStagedNotes(
      vaultRoot,
      join(vaultRoot, ".okf-vault", "tmp", "missing-staging"),
      envelope,
    );
    assert.equal(missing.report.status, "fail");
    assert.ok(missing.report.issues.some((entry) => entry.code === "STAGING_NOT_FOUND"));

    const emptyDir = join(vaultRoot, ".okf-vault", "tmp", "empty-staging");
    mkdirSync(emptyDir, { recursive: true });
    const empty = validateStagedNotes(vaultRoot, emptyDir, envelope);
    assert.equal(empty.report.status, "fail");
    assert.ok(empty.report.issues.some((entry) => entry.code === "STAGING_EMPTY"));
  });

  it("detects source mismatch, invalid SHA-256, duplicate claims, and extra slide references", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-validate-edge-"));
    initializeVault(vaultRoot);
    const stagingDir = join(vaultRoot, ".okf-vault/tmp/run-edge");
    mkdirSync(join(stagingDir, "notes"), { recursive: true });

    writeFileSync(
      join(stagingDir, "notes/source-mismatch.md"),
      `---
type: Article Note
title: Source mismatch
description: Mismatch test.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/other.md
  kind: local
  origin: /tmp/other.md
  content_sha256: not-a-valid-hash
  acquired_at: 2026-06-19T12:00:00.000Z
unknown_field: true
claims:
  - id: claim-001
    text: one
    anchors:
      - anchor-001
  - id: claim-001
    text: duplicate
    anchors:
      - anchor-001
---
# Summary
s
# Key Claims
- claim-001
# Citations
c
# Evidence
e
`,
      "utf8",
    );

    writeFileSync(
      join(stagingDir, "notes/extra-slide.md"),
      `---
type: Slide Deck Note
title: Extra slide
description: Extra slide reference.
contract_version: okf-note-contract/1.0.0
source:
  source_key: drive:deck-five
  kind: google_drive
  origin: drive:deck-five
  content_sha256: ${"a".repeat(64)}
  acquired_at: 2026-06-19T12:00:00.000Z
claims:
  - id: claim-001
    text: one
    anchors:
      - slide-001
---
# Summary
s
# Key Claims
- claim-001
# Citations
c
# Evidence
e
# Narrative
claim-001
# Slide Coverage
| 1 | covered | ok |
| 2 | covered | ok |
| 3 | covered | ok |
| 4 | covered | ok |
| 5 | covered | ok |
| 99 | covered | bad |
`,
      "utf8",
    );

    const envelope = loadEnvelope("article-local.json");
    const articleResult = validateStagedNotes(vaultRoot, stagingDir, envelope);
    const codes = articleResult.report.issues.map((entry) => entry.code);
    assert.ok(codes.includes("UNKNOWN_FRONTMATTER_FIELD"));
    assert.ok(codes.includes("SOURCE_MISMATCH"));
    assert.ok(codes.includes("INVALID_SOURCE_FIELD"));
    assert.ok(codes.includes("DUPLICATE_CLAIM_ID"));

    const deckEnvelope = loadEnvelope("deck-five-slides.json");
    const deckResult = validateStagedNotes(vaultRoot, stagingDir, deckEnvelope);
    assert.ok(deckResult.report.issues.some((entry) => entry.code === "DECK_SLIDE_MISSING"));
  });

  it("returns usage exit when validate-staged arguments are missing", () => {
    const outcome = dispatch(parseArgs(["validate-staged"]));
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assert.equal(outcome.result?.status, "error");
    if (outcome.result?.status === "error") {
      assert.equal(outcome.result.code, "USAGE_MISSING_ARGS");
    }
  });
});

describe("validate-staged CLI integration", () => {
  const bin = join(root, "dist", "main.js");

  it("exits 0 with status pass for a valid staged article in tmp staging", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-validate-pass-"));
    initializeVault(vaultRoot);
    const runId = "run-pass";
    const stagingDir = stageNote(vaultRoot, runId, "article-valid.md");
    const envelopePath = join(envelopesDir, "article-local.json");

    const beforeManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const result = spawnSync(
      process.execPath,
      [bin, "validate-staged", vaultRoot, stagingDir, envelopePath],
      { encoding: "utf8" },
    );
    const afterManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");

    assert.equal(result.status, ExitCode.SUCCESS);
    const payload = JSON.parse(result.stdout.trim()) as { status: string; data: ValidationReport };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.status, "pass");
    assert.equal(beforeManifest, afterManifest);
  });

  it("exits 0 and reports accepted staged source spans", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-validate-spans-pass-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-spans-pass", "article-valid.md");
    const envelopePath = join(envelopesDir, "article-local.json");
    const envelope = loadSourceEnvelope(envelopePath);
    const sourceSpanPaths = stageArticleSourceSpans(stagingDir, envelope);

    const result = spawnSync(
      process.execPath,
      [bin, "validate-staged", vaultRoot, stagingDir, envelopePath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, ExitCode.SUCCESS);
    const payload = JSON.parse(result.stdout.trim()) as {
      status: string;
      data: ValidationReport & {
        source_span_count: number;
        source_span_paths: string[];
        source_profile: string;
      };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.status, "pass");
    assert.equal(payload.data.source_span_count, sourceSpanPaths.length);
    assert.deepEqual(payload.data.source_span_paths, sourceSpanPaths);
    assert.equal(payload.data.source_profile, "article");
  });

  it("exits 3 and returns source-span issue codes for malformed staged spans", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-validate-spans-fail-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-spans-fail", "article-valid.md");
    const envelopePath = join(envelopesDir, "article-local.json");
    const envelope = loadSourceEnvelope(envelopePath);
    const [sourceSpanPath] = stageArticleSourceSpans(stagingDir, envelope);
    assert.ok(sourceSpanPath);
    writeFileSync(join(stagingDir, sourceSpanPath), "tampered staged span\n", { flag: "a" });

    const result = spawnSync(
      process.execPath,
      [bin, "validate-staged", vaultRoot, stagingDir, envelopePath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, ExitCode.VALIDATION);
    const payload = JSON.parse(result.stdout.trim()) as {
      status: string;
      data: ValidationReport & { source_span_count: number };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.status, "fail");
    assert.equal(payload.data.source_span_count, 1);
    assert.ok(
      payload.data.issues.some((entry) => entry.code === SOURCE_SPAN_VALIDATION_CODES.hashMismatch),
    );
  });

  it("exits 3 for a broken deck fixture without mutating managed notes", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-validate-deck-"));
    initializeVault(vaultRoot);
    const runId = "run-deck-fail";
    const stagingDir = stageNote(
      vaultRoot,
      runId,
      "deck-missing-slide-coverage.md",
      "notes/broken-deck.md",
    );
    const envelopePath = join(envelopesDir, "deck-five-slides.json");
    const managedNotePath = join(vaultRoot, "notes", "committed-note.md");
    writeFileSync(managedNotePath, "# managed\n", "utf8");

    const result = spawnSync(
      process.execPath,
      [bin, "validate-staged", vaultRoot, stagingDir, envelopePath],
      { encoding: "utf8" },
    );

    assert.equal(result.status, ExitCode.VALIDATION);
    const payload = JSON.parse(result.stdout.trim()) as {
      status: string;
      data: ValidationReport & { staged_paths?: string[] };
    };
    assert.equal(payload.data.status, "fail");
    assert.ok(payload.data.issues.some((entry) => entry.path === "notes/broken-deck.md"));
    assert.equal(readFileSync(managedNotePath, "utf8"), "# managed\n");
    assert.equal(existsSync(join(vaultRoot, "notes", "broken-deck.md")), false);
  });

  it("fails when note contract_version differs from vault manifest without staging writes", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-validate-contract-"));
    initializeVault(vaultRoot);

    const runId = "run-contract";
    const stagingDir = stageNote(vaultRoot, runId, "article-wrong-contract.md");
    const envelopePath = join(envelopesDir, "article-local.json");
    const stagedNotePath = join(stagingDir, "notes/staged-note.md");
    const stagedBefore = readFileSync(stagedNotePath, "utf8");

    const outcome = dispatch(parseArgs(["validate-staged", vaultRoot, stagingDir, envelopePath]));
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);
    assert.equal(outcome.result?.status, "ok");
    const data = outcome.result?.data as unknown as ValidationReport;
    assert.equal(data.status, "fail");
    assert.ok(data.issues.some((entry) => entry.code === "CONTRACT_VERSION_MISMATCH"));
    assert.equal(readFileSync(stagedNotePath, "utf8"), stagedBefore);
  });

  it("maps contract failures to exit class 3 through dispatch", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-dispatch-fail-"));
    initializeVault(vaultRoot);
    const stagingDir = stageNote(vaultRoot, "run-dispatch", "article-missing-sections.md");
    const envelopePath = join(envelopesDir, "article-local.json");
    const outcome = dispatch(parseArgs(["validate-staged", vaultRoot, stagingDir, envelopePath]));
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);
  });
});
