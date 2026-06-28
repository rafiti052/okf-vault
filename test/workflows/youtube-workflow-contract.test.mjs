import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CAPABILITY_NAMES,
  NORMALIZATION_ERROR_CODES,
  PROVIDER_TOOL_PATTERN,
  capabilityRequirements,
  skillRoot,
  validateEnvelopeShape,
  validateYoutubeTimestamps,
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

    for (const doc of ["capabilities.md", "source-envelope.md", "normalization.md", "ingestion-loop.md"]) {
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
});
