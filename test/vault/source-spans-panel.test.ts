import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePanelSourceSpans } from "../../dist/vault/source-spans-panel.js";
import {
  createSourceSpanSourceSlug,
  renderSourceSpanMarkdown,
} from "../../dist/vault/source-spans.js";
import { loadSourceEnvelope, type SourceEnvelope } from "../../dist/vault/validation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const panelEnvelopeDir = join(root, "test", "fixtures", "envelopes", "panel");

function loadPanelEnvelope(name: string): SourceEnvelope {
  return loadSourceEnvelope(join(panelEnvelopeDir, name));
}

function renderPanelEnvelope(envelope: SourceEnvelope): string[] {
  return generatePanelSourceSpans(envelope).map(renderSourceSpanMarkdown);
}

describe("panel transcript span generation", () => {
  it("renders identical panel envelopes to identical span documents", () => {
    const envelope = loadPanelEnvelope("accepted-01.json");

    assert.deepEqual(renderPanelEnvelope(envelope), renderPanelEnvelope(envelope));
  });

  it("preserves speaker attribution, timestamps, and paired anchor coverage", () => {
    const spans = generatePanelSourceSpans(loadPanelEnvelope("accepted-01.json"));

    assert.equal(spans.length, 2);
    assert.deepEqual(
      spans.map((span) => ({
        speaker: span.frontmatter.okv.speaker,
        timestamp: span.frontmatter.timestamp,
        anchorKind: span.frontmatter.okv.anchor_kind,
        anchors: span.frontmatter.okv.anchor_ids,
      })),
      [
        {
          speaker: "Speaker A",
          timestamp: "00:02:15",
          anchorKind: "timestamp-speaker",
          anchors: ["speaker-Speaker-A", "timestamp-00:02:15"],
        },
        {
          speaker: "Speaker B",
          timestamp: "00:08:40",
          anchorKind: "timestamp-speaker",
          anchors: ["speaker-Speaker-B", "timestamp-00:08:40"],
        },
      ],
    );
    assert.equal(
      spans[0]?.body,
      "**Speaker:** Speaker A\n\n**Timestamp:** 00:02:15\n\nWe should prioritize reliability before scale.",
    );
  });

  it("keeps envelope turn order and deterministic sibling links", () => {
    const spans = generatePanelSourceSpans(loadPanelEnvelope("accepted-01.json"));
    const firstId = spans[0]?.frontmatter.okv.span_id;
    const secondId = spans[1]?.frontmatter.okv.span_id;

    assert.deepEqual(
      spans.map((span) => span.frontmatter.timestamp),
      ["00:02:15", "00:08:40"],
    );
    assert.equal(spans[0]?.frontmatter.okv.next, secondId);
    assert.equal(spans[0]?.frontmatter.okv.prev, undefined);
    assert.equal(spans[1]?.frontmatter.okv.prev, firstId);
    assert.equal(spans[1]?.frontmatter.okv.next, undefined);
  });

  it("emits timestamp-only turns without inventing speakers", () => {
    const spans = generatePanelSourceSpans(loadPanelEnvelope("timestamp-only-01.json"));

    assert.equal(spans.length, 2);
    assert.deepEqual(
      spans.map((span) => ({
        speaker: span.frontmatter.okv.speaker,
        timestamp: span.frontmatter.timestamp,
        anchorKind: span.frontmatter.okv.anchor_kind,
      })),
      [
        { speaker: undefined, timestamp: "00:01:00", anchorKind: "timestamp" },
        { speaker: undefined, timestamp: "00:03:30", anchorKind: "timestamp" },
      ],
    );
    assert.doesNotMatch(renderSourceSpanMarkdown(spans[0]!), /Speaker:/u);
  });

  it("preserves sparse speaker-only turns and does not merge mismatched speakers", () => {
    const envelope: SourceEnvelope = {
      ...loadPanelEnvelope("accepted-01.json"),
      anchors: [
        {
          id: "speaker-Speaker-A",
          kind: "speaker",
          label: "Speaker A",
          speaker: "Speaker A",
          text: "A speaker-only opening.",
        },
        {
          id: "timestamp-00:02:15",
          kind: "timestamp",
          timestamp: "00:02:15",
          speaker: "Speaker B",
          text: "A differently attributed response.",
        },
        {
          id: "speaker-Speaker-C",
          kind: "speaker",
          label: "Speaker C",
          text: "A final turn without a timestamp.",
        },
      ],
    };

    const spans = generatePanelSourceSpans(envelope);

    assert.deepEqual(
      spans.map((span) => ({
        speaker: span.frontmatter.okv.speaker,
        timestamp: span.frontmatter.timestamp,
        anchorKind: span.frontmatter.okv.anchor_kind,
      })),
      [
        { speaker: "Speaker A", timestamp: undefined, anchorKind: "speaker" },
        { speaker: "Speaker B", timestamp: "00:02:15", anchorKind: "timestamp-speaker" },
        { speaker: "Speaker C", timestamp: undefined, anchorKind: "speaker" },
      ],
    );
  });

  it("fails closed when the envelope has no usable transcript turn text", () => {
    const envelope: SourceEnvelope = {
      ...loadPanelEnvelope("accepted-01.json"),
      anchors: [{ id: "other-001", kind: "text", text: "Ignored generic text." }],
    };

    assert.throws(() => generatePanelSourceSpans(envelope), /no usable transcript turns/u);
  });
});

describe("panel transcript span fixture integration", () => {
  it("emits the expected stable span set for a gold panel envelope", () => {
    const envelope = loadPanelEnvelope("accepted-02.json");
    const spans = generatePanelSourceSpans(envelope);
    const sourceSlug = createSourceSpanSourceSlug(envelope.source_key, envelope.content_sha256);

    assert.deepEqual(
      spans.map((span) => span.relativePath),
      [
        `references/sources/${sourceSlug}/span-001.md`,
        `references/sources/${sourceSlug}/span-002.md`,
      ],
    );
    assert.deepEqual(
      spans.map((span) => span.frontmatter.okv.speaker),
      ["Moderator", "Panelist One"],
    );
    assert.deepEqual(
      spans.map((span) => span.frontmatter.timestamp),
      ["00:01:05", "00:04:30"],
    );
  });

  it("preserves paths, speaker metadata, and markdown bytes across repeated generation", () => {
    const envelopePath = join(panelEnvelopeDir, "accepted-02.json");
    const first = generatePanelSourceSpans(loadSourceEnvelope(envelopePath));
    const second = generatePanelSourceSpans(loadSourceEnvelope(envelopePath));

    assert.deepEqual(
      first.map((span) => ({
        path: span.relativePath,
        speaker: span.frontmatter.okv.speaker,
        markdown: renderSourceSpanMarkdown(span),
      })),
      second.map((span) => ({
        path: span.relativePath,
        speaker: span.frontmatter.okv.speaker,
        markdown: renderSourceSpanMarkdown(span),
      })),
    );
  });

  it("keeps panel implementation isolated from other profile generators", () => {
    const source = readFileSync(join(process.cwd(), "src/vault/source-spans-panel.ts"), "utf8");
    assert.doesNotMatch(source, /source-spans-(?:article|video|deck)/u);
  });
});
