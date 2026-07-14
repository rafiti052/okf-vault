import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { SOURCE_SPAN_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  createSourceSpanDocument,
  createSourceSpanFileName,
  createSourceSpanId,
  createSourceSpanMetadata,
  createSourceSpanRelativePath,
  createSourceSpanSiblingMetadata,
  createSourceSpanSourceSlug,
  renderSourceSpanMarkdown,
  type SourceSpanDocumentInput,
  type SourceSpanProfile,
} from "../../dist/vault/source-spans.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function articleInput(overrides: Partial<SourceSpanDocumentInput> = {}): SourceSpanDocumentInput {
  return {
    sourceKey: "local:/tmp/sources/sample-article.md",
    contentSha256: SHA_A,
    profile: "article",
    sequence: 1,
    anchorIds: ["anchor-002", "anchor-001", "anchor-001"],
    title: "Sample Article — span 1",
    description: "Evidence from the opening section.",
    body: "Revenue grew 12% year over year.",
    resource: "file:///tmp/sources/sample-article.md",
    heading: "Revenue",
    parentLabel: "Results",
    tags: ["article", "source-span", "article"],
    ...overrides,
  };
}

function parsedFrontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  assert.notEqual(match, null);
  return parseYaml(match![1]!) as Record<string, unknown>;
}

describe("source-span deterministic rendering", () => {
  it("renders the same span input to identical canonical markdown", () => {
    const first = renderSourceSpanMarkdown(createSourceSpanDocument(articleInput()));
    const second = renderSourceSpanMarkdown(createSourceSpanDocument(articleInput()));

    assert.equal(first, second);
    assert.equal(first.endsWith("Revenue grew 12% year over year.\n"), true);
    assert.equal(first.includes("\r"), false);

    const frontmatter = parsedFrontmatter(first);
    assert.equal(frontmatter.type, "Source Span");
    assert.equal(frontmatter.contract_version, SOURCE_SPAN_CONTRACT_VERSION);
    assert.deepEqual(frontmatter.tags, ["article", "source-span"]);
  });

  it("normalizes CRLF and surrounding whitespace without changing internal prose", () => {
    const document = createSourceSpanDocument(
      articleInput({ body: "\r\n  First line.\r\nSecond line.  \r\n" }),
    );
    assert.equal(document.body, "  First line.\nSecond line.  ");
    assert.match(renderSourceSpanMarkdown(document), / {2}First line\.\nSecond line\. {2}\n$/u);
  });

  it("rejects empty required document fields", () => {
    assert.throws(() => createSourceSpanDocument(articleInput({ title: " " })), /title/);
    assert.throws(() => createSourceSpanDocument(articleInput({ description: "" })), /description/);
    assert.throws(() => createSourceSpanDocument(articleInput({ body: "\r\n" })), /body/);
    assert.throws(() => createSourceSpanDocument(articleInput({ tags: [""] })), /tags/);
  });
});

describe("source-span naming and stable identity", () => {
  it("keeps content addressing in the source namespace while preserving span-XXX filenames", () => {
    const slug = createSourceSpanSourceSlug("local:/tmp/sources/Sámple Article.md", SHA_A);
    assert.match(slug, /^sample-article-[a-f0-9]{12}$/u);
    assert.equal(createSourceSpanFileName(1), "span-001.md");
    assert.equal(createSourceSpanFileName(1200), "span-1200.md");
    assert.equal(createSourceSpanRelativePath(slug, 1), `references/sources/${slug}/span-001.md`);
    assert.notEqual(slug, createSourceSpanSourceSlug("local:/another/Sámple Article.md", SHA_A));
  });

  it("derives stable IDs and changes identity when content changes", () => {
    const first = createSourceSpanId("local:/tmp/article.md", SHA_A, "article", 1);
    assert.equal(first, createSourceSpanId("local:/tmp/article.md", SHA_A, "article", 1));
    assert.notEqual(first, createSourceSpanId("local:/tmp/article.md", SHA_B, "article", 1));
    assert.notEqual(first, createSourceSpanId("local:/tmp/article.md", SHA_A, "article", 2));
    assert.notEqual(first, createSourceSpanId("local:/tmp/article.md", SHA_A, "video", 1));
    assert.match(first, /^span-001-[a-f0-9]{16}$/u);
  });

  it("uses a safe fallback when a source identity has no slug characters", () => {
    assert.match(createSourceSpanSourceSlug("local:/tmp/🧪.md", SHA_A), /^source-[a-f0-9]{12}$/u);
  });

  it("rejects traversal, absolute paths, invalid characters, hashes, and sequences", () => {
    for (const slug of ["../evil", "/absolute", "nested/path", "bad slug", "bad_slug", ""])
      assert.throws(() => createSourceSpanRelativePath(slug, 1), /path-safe/);
    for (const sequence of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      assert.throws(() => createSourceSpanFileName(sequence), /sequence/);
    assert.throws(() => createSourceSpanSourceSlug("local:/tmp/a.md", "A".repeat(64)), /digest/);
    assert.throws(() => createSourceSpanId(" ", SHA_A, "article", 1), /sourceKey/);
    assert.throws(
      () => createSourceSpanId("local:/tmp/a.md", SHA_A, "audio" as SourceSpanProfile, 1),
      /Unsupported/,
    );
  });
});

describe("source-span metadata and siblings", () => {
  it("preserves all required and optional shared metadata fields", () => {
    const metadata = createSourceSpanMetadata({
      sourceKey: "granola:panel-001",
      contentSha256: SHA_A,
      profile: "panel",
      sequence: 2,
      anchorIds: ["speaker-a", "timestamp-001"],
      prev: "span-001-aabbccdd",
      next: "span-003-aabbccdd",
      speaker: "Speaker A",
      slideNumber: 4,
      anchorKind: "timestamp-speaker",
      heading: "Reliability",
      parentLabel: "Panel opening",
    });

    assert.equal(metadata.source_key, "granola:panel-001");
    assert.equal(metadata.content_sha256, SHA_A);
    assert.equal(metadata.profile, "panel");
    assert.equal(metadata.sequence, 2);
    assert.deepEqual(metadata.anchor_ids, ["speaker-a", "timestamp-001"]);
    assert.equal(metadata.prev, "span-001-aabbccdd");
    assert.equal(metadata.next, "span-003-aabbccdd");
    assert.equal(metadata.speaker, "Speaker A");
    assert.equal(metadata.slide_number, 4);
    assert.equal(metadata.anchor_kind, "timestamp-speaker");
    assert.equal(metadata.heading, "Reliability");
    assert.equal(metadata.parent_label, "Panel opening");
  });

  it("creates bounded previous and next links for ordered span IDs", () => {
    const ids = ["span-001-aabbccdd", "span-002-aabbccdd", "span-003-aabbccdd"];
    assert.deepEqual(createSourceSpanSiblingMetadata(ids, 0), { next: ids[1] });
    assert.deepEqual(createSourceSpanSiblingMetadata(ids, 1), { prev: ids[0], next: ids[2] });
    assert.deepEqual(createSourceSpanSiblingMetadata(ids, 2), { prev: ids[1] });
  });

  it("rejects invalid sibling lists and malformed metadata", () => {
    assert.throws(() => createSourceSpanSiblingMetadata([], 0), /index/);
    assert.throws(() => createSourceSpanSiblingMetadata(["span-001"], 1), /index/);
    assert.throws(() => createSourceSpanSiblingMetadata(["span-001", "span-001"], 0), /unique/);
    assert.throws(() => createSourceSpanSiblingMetadata(["../span"], 0), /spanId/);
    assert.throws(
      () => createSourceSpanMetadata({ ...articleInput(), profile: "audio" as SourceSpanProfile }),
      /Unsupported/,
    );
    assert.throws(
      () => createSourceSpanMetadata({ ...articleInput(), slideNumber: 0 }),
      /slideNumber/,
    );
    assert.throws(() => createSourceSpanMetadata({ ...articleInput(), prev: " " }), /prev/);
    assert.throws(
      () => createSourceSpanMetadata({ ...articleInput(), next: "../span-002" }),
      /valid span ID/,
    );
    assert.throws(
      () => createSourceSpanMetadata({ ...articleInput(), anchorIds: [""] }),
      /anchorIds/,
    );
  });
});

describe("shared contract profile integration", () => {
  it("supports representative shared documents for every current profile", () => {
    const examples: Array<{
      profile: SourceSpanProfile;
      extra: Partial<SourceSpanDocumentInput>;
    }> = [
      { profile: "article", extra: { heading: "Results" } },
      { profile: "video", extra: { timestamp: "00:03:45", anchorKind: "timestamp" } },
      {
        profile: "panel",
        extra: { timestamp: "00:02:15", speaker: "Speaker A", anchorKind: "speaker" },
      },
      { profile: "deck", extra: { slideNumber: 4, anchorKind: "speaker_note" } },
    ];

    for (const [index, example] of examples.entries()) {
      const input = articleInput({
        profile: example.profile,
        sequence: index + 1,
        title: `${example.profile} span`,
        ...example.extra,
      });
      delete input.tags;
      const document = createSourceSpanDocument(input);
      assert.equal(document.frontmatter.okv.profile, example.profile);
      assert.equal(document.relativePath.endsWith(createSourceSpanFileName(index + 1)), true);
      assert.match(renderSourceSpanMarkdown(document), /^---\n/u);
    }
  });

  it("has no dependency on later profile generators, preserving one-way imports", () => {
    const sharedModule = readFileSync(join(process.cwd(), "src/vault/source-spans.ts"), "utf8");
    assert.doesNotMatch(sharedModule, /source-spans-(?:article|video|panel|deck)/u);
  });
});
