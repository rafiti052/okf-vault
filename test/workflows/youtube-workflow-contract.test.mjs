import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  commitIngestFixture,
  parseIngestRunInput,
  resolveManifestPreflight,
  selectConversionProfile,
} from "../../dist/vault/ingestion.js";
import { initializeVault, loadManifest, manifestRevision } from "../../dist/vault/manifest.js";
import { youtubeAccepted } from "../../dist-test/fixtures/youtube-fixtures.js";
import {
  buildWizardHandoffInput,
  CAPABILITY_NAMES,
  NORMALIZATION_ERROR_CODES,
  PROVIDER_TOOL_PATTERN,
  capabilityRequirements,
  documentsYoutubeAlreadyProcessedSemantics,
  documentsYoutubeTranscriptUnavailableFailure,
  loadEnvelopeFixture,
  simulateYoutubeAlreadyProcessedPath,
  simulateYoutubeTranscriptUnavailableWizardFailure,
  skillRoot,
  validateEnvelopeShape,
  validateYoutubeTimestamps,
  validateYoutubeWizardHandoff,
  verifyTranscriptUnavailableStopsBeforeConversion,
  verifyYoutubeAlreadyProcessedOrdering,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const refsDir = join(skillRoot(root), "references");

const YOUTUBE_DOCS = [
  "ingest-wizard.md",
  "capabilities.md",
  "source-envelope.md",
  "normalization.md",
  "ingestion-loop.md",
];

/**
 * @param {string} name
 * @returns {string}
 */
function readRef(name) {
  return readFileSync(join(refsDir, name), "utf8");
}

describe("YouTube workflow contract consistency", () => {
  it("documents youtube kind and fetch_youtube_transcript across workflow references", () => {
    for (const doc of YOUTUBE_DOCS) {
      const text = readRef(doc);
      assert.match(text, /youtube/i, `${doc} must mention youtube`);
    }

    for (const doc of [
      "capabilities.md",
      "source-envelope.md",
      "normalization.md",
      "ingestion-loop.md",
    ]) {
      const text = readRef(doc);
      assert.doesNotMatch(text, PROVIDER_TOOL_PATTERN, `${doc} must stay provider-neutral`);
    }

    const capabilities = readRef("capabilities.md");
    assert.match(capabilities, /fetch_youtube_transcript/);
    assert.ok(CAPABILITY_NAMES.includes("fetch_youtube_transcript"));

    const wizard = readRef("ingest-wizard.md");
    assert.match(wizard, /acquire_youtube/);
    assert.match(wizard, /default available transcript/i);

    const envelope = readRef("source-envelope.md");
    assert.match(envelope, /youtube:/);
    assert.match(envelope, /11-character video ID|11-char video ID/i);

    const normalization = readRef("normalization.md");
    assert.match(normalization, /INCOMPLETE_TRANSCRIPT_TIMESTAMPS/);

    const loop = readRef("ingestion-loop.md");
    assert.match(loop, /YouTube MVP profile routing/i);
  });

  it("capability mapping for youtube requires transcript capability plus invoke_process", () => {
    assert.deepEqual(capabilityRequirements("youtube"), [
      "fetch_youtube_transcript",
      "invoke_process",
    ]);
  });

  it("preserves existing Drive, Granola, and local workflow expectations in capabilities", () => {
    const capabilities = readRef("capabilities.md");
    for (const kind of ["local", "google_drive", "granola"]) {
      assert.match(capabilities, new RegExp(`\`${kind}\``));
    }
    assert.deepEqual(capabilityRequirements("local"), ["read_local_file", "invoke_process"]);
    assert.deepEqual(capabilityRequirements("google_drive"), [
      "fetch_drive_document",
      "invoke_process",
    ]);
    assert.deepEqual(capabilityRequirements("granola"), [
      "fetch_granola_transcript",
      "invoke_process",
    ]);
  });

  it("rejects YouTube envelope missing timestamp anchors", () => {
    const envelope = {
      contract_version: "okf-source-envelope/1.0.0",
      source_key: "youtube:dQw4w9WgXcQ",
      kind: "youtube",
      content_type: "text/vtt",
      origin: "youtube:dQw4w9WgXcQ",
      canonical_uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Sample Video",
      modified_at: "2026-01-01T00:00:00.000Z",
      content_sha256: "a".repeat(64),
      normalized_text: "Transcript without timestamps.",
      anchors: [],
    };

    const shape = validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);

    const timestamps = validateYoutubeTimestamps(envelope, { requireTimestampAnchors: true });
    assert.equal(timestamps.ok, false);
    if (!timestamps.ok) {
      assert.equal(timestamps.code, NORMALIZATION_ERROR_CODES.incompleteTranscriptTimestamps);
    }
  });

  it("accepts YouTube envelope with timestamp anchors", () => {
    const envelope = {
      contract_version: "okf-source-envelope/1.0.0",
      source_key: "youtube:dQw4w9WgXcQ",
      kind: "youtube",
      content_type: "text/vtt",
      origin: "youtube:dQw4w9WgXcQ",
      canonical_uri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "Sample Video",
      modified_at: "2026-01-01T00:00:00.000Z",
      content_sha256: "b".repeat(64),
      normalized_text: "00:00:01 Opening remarks.",
      anchors: [
        {
          id: "anchor-001",
          kind: "timestamp",
          label: "00:00:01",
          text: "Opening remarks.",
          timestamp: "00:00:01",
        },
      ],
    };

    const shape = validateEnvelopeShape(envelope);
    assert.equal(shape.ok, true);

    const timestamps = validateYoutubeTimestamps(envelope, { requireTimestampAnchors: true });
    assert.equal(timestamps.ok, true);
  });

  it("documents transcript-unavailable failure stops before confirm_source with ADR-009 choices", () => {
    const wizard = readRef("ingest-wizard.md");
    const loop = readRef("ingestion-loop.md");

    assert.equal(documentsYoutubeTranscriptUnavailableFailure(wizard), true);
    assert.match(wizard, /Missing usable timestamps/i);
    assert.match(wizard, /ambiguous.*confirm.*panel|confirm.*`panel`/i);

    const failureEvents = simulateYoutubeTranscriptUnavailableWizardFailure("run-youtube-fail");
    assert.equal(verifyTranscriptUnavailableStopsBeforeConversion(failureEvents), true);
    assert.equal(failureEvents[0]?.event, "run_failed");
    assert.doesNotMatch(loop, /transcript unavailable.*conversion_started/is);
  });

  it("documents unchanged YouTube source repeat-ingest as source_already_processed", () => {
    const wizard = readRef("ingest-wizard.md");
    const loop = readRef("ingestion-loop.md");

    assert.equal(documentsYoutubeAlreadyProcessedSemantics(wizard), true);
    assert.match(loop, /`youtube`/);
    assert.match(loop, /source_already_processed/);
    assert.match(loop, /Skip.*conversion and commit/i);

    const events = simulateYoutubeAlreadyProcessedPath("run-youtube-repeat", "youtube:dQw4w9WgXcQ");
    assert.equal(verifyYoutubeAlreadyProcessedOrdering(events), true);
  });

  it("wires youtube handoff content_type to default video profile selection", () => {
    const envelope = loadEnvelopeFixture(youtubeAccepted.envelopePath);
    const contentType = String(envelope.content_type);

    assert.equal(selectConversionProfile(contentType, { kind: "youtube" }), "video");

    const handoff = buildWizardHandoffInput("knowledge", "run-youtube-profile", {
      kind: "youtube",
      locator: String(envelope.canonical_uri),
      content_type: contentType,
    });

    const shape = validateYoutubeWizardHandoff(handoff);
    assert.equal(shape.ok, true);

    const parsed = parseIngestRunInput(handoff);
    assert.equal(
      selectConversionProfile(parsed.sources[0]?.content_type ?? "", { kind: "youtube" }),
      "video",
    );
  });

  it("re-ingesting unchanged YouTube source emits source_already_processed without conversion", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-youtube-workflow-repeat-"));
    initializeVault(vaultRoot);
    const revision = manifestRevision(loadManifest(vaultRoot));
    const envelope = loadEnvelopeFixture(youtubeAccepted.envelopePath);

    commitIngestFixture({
      vaultRoot,
      runId: "run-youtube-first",
      envelopePath: youtubeAccepted.envelopePath,
      goldNotePath: youtubeAccepted.notePath,
      stagedNotePath: youtubeAccepted.stagedNotePath,
      expectedRevision: revision,
    });

    const preflight = resolveManifestPreflight(
      loadManifest(vaultRoot),
      "youtube",
      String(envelope.origin),
      String(envelope.content_sha256),
      "run-youtube-repeat",
    );

    assert.equal(preflight.outcome, "already_processed");
    assert.equal(preflight.stop_before_conversion, true);
    assert.equal(preflight.progress_event.event, "source_already_processed");
    assert.equal(preflight.progress_event.commit_id, undefined);

    const events = simulateYoutubeAlreadyProcessedPath(
      "run-youtube-repeat",
      String(envelope.source_key),
    );
    assert.equal(verifyYoutubeAlreadyProcessedOrdering(events), true);
  });
});
