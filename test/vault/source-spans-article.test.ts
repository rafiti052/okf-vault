import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateArticleSpanDocuments,
  type ArticleSourceEnvelope,
} from "../../dist/vault/source-spans-article.js";
import {
  createSourceSpanSourceSlug,
  renderSourceSpanMarkdown,
} from "../../dist/vault/source-spans.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const envelopeDir = join(root, "test", "fixtures", "envelopes", "article");
const goldDir = join(root, "test", "fixtures", "source-spans", "article");

function loadEnvelope(name: string): ArticleSourceEnvelope {
  return JSON.parse(readFileSync(join(envelopeDir, name), "utf8")) as ArticleSourceEnvelope;
}

function renderAll(envelope: ArticleSourceEnvelope): string[] {
  return generateArticleSpanDocuments(envelope).map(renderSourceSpanMarkdown);
}

describe("article source-span generation", () => {
  it("produces identical documents and markdown for identical envelopes", () => {
    const envelope = loadEnvelope("span-sections.json");

    const first = generateArticleSpanDocuments(envelope);
    const second = generateArticleSpanDocuments(envelope);

    assert.deepEqual(first, second);
    assert.deepEqual(first.map(renderSourceSpanMarkdown), second.map(renderSourceSpanMarkdown));
  });

  it("preserves anchor order, section context, labels, and bounded sibling metadata", () => {
    const envelope = loadEnvelope("span-sections.json");
    const documents = generateArticleSpanDocuments(envelope);

    assert.equal(documents.length, 3);
    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.sequence),
      [1, 2, 3],
    );
    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.anchor_ids),
      [["anchor-001"], ["anchor-002"], ["anchor-003"]],
    );
    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.heading),
      ["Growth", "Rollout", "Rollout"],
    );
    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.parent_label),
      ["Growth metrics", "Rollout phase one", "Rollout phase two"],
    );
    assert.equal(documents[0]!.frontmatter.okv.prev, undefined);
    assert.equal(documents[0]!.frontmatter.okv.next, documents[1]!.frontmatter.okv.span_id);
    assert.equal(documents[1]!.frontmatter.okv.prev, documents[0]!.frontmatter.okv.span_id);
    assert.equal(documents[1]!.frontmatter.okv.next, documents[2]!.frontmatter.okv.span_id);
    assert.equal(documents[2]!.frontmatter.okv.prev, documents[1]!.frontmatter.okv.span_id);
    assert.equal(documents[2]!.frontmatter.okv.next, undefined);
  });

  it("uses the deterministic span label fallback when headings and labels are absent", () => {
    const [document] = generateArticleSpanDocuments(loadEnvelope("span-no-headings.json"));

    assert.ok(document);
    assert.equal(document.frontmatter.okv.heading, undefined);
    assert.equal(document.frontmatter.okv.parent_label, undefined);
    assert.equal(document.frontmatter.description, "Article evidence from span 1.");
    assert.equal(document.body, "A deterministic fallback keeps unheaded prose inspectable.");
  });

  it("advances heading lookup for repeated prose in ordered sections", () => {
    const envelope = loadEnvelope("span-no-headings.json");
    envelope.normalized_text = "## First\nRepeated evidence.\n\n## Second\nRepeated evidence.";
    envelope.anchors = [
      { id: "anchor-001", kind: "text", text: "Repeated evidence." },
      { id: "anchor-002", kind: "text", text: "Repeated evidence." },
    ];

    assert.deepEqual(
      generateArticleSpanDocuments(envelope).map((document) => document.frontmatter.okv.heading),
      ["First", "Second"],
    );
  });

  it("falls back to one normalized-text span when anchors have no usable text", () => {
    const envelope = loadEnvelope("span-no-headings.json");
    envelope.anchors = [{ id: "anchor-ignored", kind: "text", label: "Metadata only" }];
    envelope.normalized_text = "# Whole document\n\nFallback body.";
    envelope.canonical_uri = " ";

    const [document] = generateArticleSpanDocuments(envelope);

    assert.ok(document);
    assert.equal(document.body, "# Whole document\n\nFallback body.");
    assert.deepEqual(document.frontmatter.okv.anchor_ids, []);
    assert.equal(document.frontmatter.okv.heading, "Whole document");
    assert.equal(document.frontmatter.resource, undefined);
  });

  it("rejects an article envelope without normalized text or text anchors", () => {
    const envelope = loadEnvelope("span-no-headings.json");
    envelope.normalized_text = " ";
    envelope.anchors = [{ id: "anchor-001", kind: "text", text: " " }];

    assert.throws(
      () => generateArticleSpanDocuments(envelope),
      /requires normalized_text or at least one text anchor/u,
    );
  });
});

describe("article source-span markdown fixtures", () => {
  it("emits the expected article document set byte-for-byte", () => {
    const envelope = loadEnvelope("span-sections.json");
    const documents = generateArticleSpanDocuments(envelope);
    const sourceSlug = createSourceSpanSourceSlug(envelope.source_key, envelope.content_sha256);

    assert.deepEqual(
      documents.map((document) => document.relativePath),
      [1, 2, 3].map(
        (sequence) =>
          `references/sources/${sourceSlug}/span-${String(sequence).padStart(3, "0")}.md`,
      ),
    );
    assert.deepEqual(
      documents.map(renderSourceSpanMarkdown),
      ["span-001.md", "span-002.md", "span-003.md"].map((name) =>
        readFileSync(join(goldDir, "span-sections", name), "utf8"),
      ),
    );
  });

  it("keeps the heading-free gold output stable across repeated runs", () => {
    const envelope = loadEnvelope("span-no-headings.json");
    const expected = readFileSync(join(goldDir, "span-no-headings", "span-001.md"), "utf8");

    assert.deepEqual(renderAll(envelope), [expected]);
    assert.deepEqual(renderAll(envelope), renderAll(envelope));
  });
});
