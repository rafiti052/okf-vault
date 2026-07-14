import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse as parseYaml } from "yaml";
import {
  generateVideoSourceSpans,
  type VideoTranscriptEnvelope,
} from "../../dist/vault/source-spans-video.js";
import { createSourceSpanId, renderSourceSpanMarkdown } from "../../dist/vault/source-spans.js";

const FIXTURE_PATH = join(process.cwd(), "test/fixtures/envelopes/video/span-generation-gold.json");

function loadFixture(): VideoTranscriptEnvelope {
  return JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as VideoTranscriptEnvelope;
}

function parsedFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  assert.notEqual(match, null);
  return parseYaml(match![1]!) as Record<string, unknown>;
}

describe("video transcript source-span generation", () => {
  it("renders identical transcript envelopes to identical span documents", () => {
    const first = generateVideoSourceSpans(loadFixture()).map(renderSourceSpanMarkdown);
    const second = generateVideoSourceSpans(loadFixture()).map(renderSourceSpanMarkdown);

    assert.deepEqual(first, second);
    assert.equal(first.length, 3);
    assert.equal(
      first.every((markdown) => markdown.startsWith("---\n")),
      true,
    );
  });

  it("preserves timestamp metadata and transcript text for every emitted span", () => {
    const documents = generateVideoSourceSpans(loadFixture());

    assert.deepEqual(
      documents.map((document) => ({
        timestamp: document.frontmatter.timestamp,
        anchorIds: document.frontmatter.okv.anchor_ids,
        body: document.body,
      })),
      [
        {
          timestamp: "00:00:05",
          anchorIds: ["timestamp-00:00:05"],
          body: "Welcome to the launch.",
        },
        {
          timestamp: "00:02:10",
          anchorIds: ["timestamp-00:02:10"],
          body: "Reliability is the first principle.",
        },
        {
          timestamp: "00:05:45",
          anchorIds: ["timestamp-00:05:45"],
          body: "Review the rollout checklist before deployment.",
        },
      ],
    );

    for (const document of documents) {
      const frontmatter = parsedFrontmatter(renderSourceSpanMarkdown(document));
      assert.equal(frontmatter.timestamp, document.frontmatter.timestamp);
      assert.equal(document.frontmatter.okv.profile, "video");
      assert.equal(document.frontmatter.okv.anchor_kind, "timestamp");
    }
  });

  it("keeps adjacent timestamp segments linked in envelope order", () => {
    const envelope = loadFixture();
    const documents = generateVideoSourceSpans(envelope);
    const spanIds = documents.map((document) => document.frontmatter.okv.span_id);

    assert.deepEqual(
      spanIds,
      [1, 2, 3].map((sequence) =>
        createSourceSpanId(envelope.source_key, envelope.content_sha256, "video", sequence),
      ),
    );
    assert.deepEqual(
      documents.map(({ frontmatter }) => ({
        prev: frontmatter.okv.prev,
        next: frontmatter.okv.next,
      })),
      [
        { prev: undefined, next: spanIds[1] },
        { prev: spanIds[0], next: spanIds[2] },
        { prev: spanIds[1], next: undefined },
      ],
    );
  });

  it("emits the gold fixture span set with stable ordering and paths", () => {
    const first = generateVideoSourceSpans(loadFixture());
    const second = generateVideoSourceSpans(loadFixture());

    assert.deepEqual(
      first.map((document) => ({
        sequence: document.frontmatter.okv.sequence,
        timestamp: document.frontmatter.timestamp,
        fileName: document.relativePath.split("/").at(-1),
      })),
      [
        { sequence: 1, timestamp: "00:00:05", fileName: "span-001.md" },
        { sequence: 2, timestamp: "00:02:10", fileName: "span-002.md" },
        { sequence: 3, timestamp: "00:05:45", fileName: "span-003.md" },
      ],
    );
    assert.deepEqual(
      first.map((document) => document.relativePath),
      second.map((document) => document.relativePath),
    );
  });

  it("ignores non-timestamp anchors without changing timestamp adjacency", () => {
    const envelope = loadFixture();
    envelope.anchors.splice(1, 0, {
      id: "section-opening",
      kind: "section",
      label: "Opening section",
      text: "Section marker",
    });

    const documents = generateVideoSourceSpans(envelope);

    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.anchor_ids[0]),
      ["timestamp-00:00:05", "timestamp-00:02:10", "timestamp-00:05:45"],
    );
    assert.equal(documents[0]?.frontmatter.okv.next, documents[1]?.frontmatter.okv.span_id);
  });

  it("fails closed for missing or malformed timestamp segments", () => {
    const noTimestamps = loadFixture();
    noTimestamps.anchors = [];
    assert.throws(() => generateVideoSourceSpans(noTimestamps), /timestamp anchor/u);

    const missingTimestamp = loadFixture();
    delete missingTimestamp.anchors[0]!.timestamp;
    assert.throws(() => generateVideoSourceSpans(missingTimestamp), /timestamp.*non-empty/u);

    const missingText = loadFixture();
    delete missingText.anchors[0]!.text;
    assert.throws(() => generateVideoSourceSpans(missingText), /text.*non-empty/u);

    const duplicateAnchor = loadFixture();
    duplicateAnchor.anchors[1]!.id = duplicateAnchor.anchors[0]!.id;
    assert.throws(() => generateVideoSourceSpans(duplicateAnchor), /anchor IDs must be unique/u);
  });

  it("does not depend on article, panel, or deck generators", () => {
    const moduleSource = readFileSync(
      join(process.cwd(), "src/vault/source-spans-video.ts"),
      "utf8",
    );
    assert.doesNotMatch(moduleSource, /source-spans-(?:article|panel|deck)/u);
  });
});
