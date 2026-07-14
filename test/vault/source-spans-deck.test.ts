import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { generateDeckSourceSpans } from "../../dist/vault/source-spans-deck.js";
import { renderSourceSpanMarkdown } from "../../dist/vault/source-spans.js";
import { loadSourceEnvelope, type SourceEnvelope } from "../../dist/vault/validation.js";

const fixturePath = join(
  process.cwd(),
  "test",
  "fixtures",
  "envelopes",
  "deck",
  "span-generation.json",
);

function loadDeck(): SourceEnvelope {
  return loadSourceEnvelope(fixturePath);
}

function renderDeck(envelope = loadDeck()): string[] {
  return generateDeckSourceSpans(envelope).map(renderSourceSpanMarkdown);
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  assert.notEqual(match, null);
  return parseYaml(match![1]!) as Record<string, unknown>;
}

describe("deck source-span generation", () => {
  it("renders identical deck envelopes to identical markdown documents", () => {
    assert.deepEqual(renderDeck(), renderDeck());
  });

  it("keeps slide numbers ordered and pairs speaker notes immediately after their slide", () => {
    const documents = generateDeckSourceSpans(loadDeck());

    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.slide_number),
      [1, 2, 2, 3],
    );
    assert.deepEqual(
      documents.map((document) => document.frontmatter.okv.anchor_kind),
      ["slide", "slide", "speaker_note", "slide"],
    );
    assert.equal(documents[2]?.frontmatter.okv.parent_label, "Slide 2: Next release");
    assert.equal(documents[2]?.body, "Keep the rollout bounded and deterministic.");
  });

  it("preserves anchor coverage and deck metadata in rendered markdown", () => {
    const markdown = renderDeck();
    const slideTwo = frontmatter(markdown[1]!);
    const speakerNote = frontmatter(markdown[2]!);

    assert.deepEqual((slideTwo.okv as Record<string, unknown>).anchor_ids, [
      "slide-002",
      "slide-002-detail",
    ]);
    assert.equal((slideTwo.okv as Record<string, unknown>).slide_number, 2);
    assert.equal((slideTwo.okv as Record<string, unknown>).anchor_kind, "slide");
    assert.equal(slideTwo.resource, "file:///tmp/sources/product-roadmap.pptx");
    assert.deepEqual((speakerNote.okv as Record<string, unknown>).anchor_ids, ["speaker-002"]);
    assert.deepEqual(speakerNote.tags, ["deck", "source-span", "speaker-note"]);
    assert.match(markdown[1]!, /Next release\nShip the evidence path first\n$/u);
  });

  it("rejects incomplete, gapped, unanchored, and empty slide inputs", () => {
    const incomplete = { ...loadDeck(), deck_complete: false };
    assert.throws(() => generateDeckSourceSpans(incomplete), /deck_complete/);

    const gapped = loadDeck();
    gapped.slides = [gapped.slides![0]!, { ...gapped.slides![1]!, number: 3 }];
    assert.throws(() => generateDeckSourceSpans(gapped), /ordered without gaps/);

    const unanchored = loadDeck();
    unanchored.anchors = unanchored.anchors.filter((anchor) => anchor.slide_number !== 1);
    assert.throws(() => generateDeckSourceSpans(unanchored), /slide 1.*anchor/);

    const emptySlide = loadDeck();
    emptySlide.slides = [{ ...emptySlide.slides![0]!, text: " " }, ...emptySlide.slides!.slice(1)];
    assert.throws(() => generateDeckSourceSpans(emptySlide), /slide 1 text/);
  });

  it("rejects speaker notes without a paired speaker-note anchor", () => {
    const envelope = loadDeck();
    envelope.anchors = envelope.anchors.filter((anchor) => anchor.kind !== "speaker_note");
    assert.throws(() => generateDeckSourceSpans(envelope), /speaker_note anchor/);
  });
});

describe("deck source-span fixture integration", () => {
  it("emits the expected stable span set with bounded sibling links", () => {
    const documents = generateDeckSourceSpans(loadDeck());
    const ids = documents.map((document) => document.frontmatter.okv.span_id);

    assert.deepEqual(
      documents.map((document) => document.relativePath.match(/span-\d+\.md$/u)?.[0]),
      ["span-001.md", "span-002.md", "span-003.md", "span-004.md"],
    );
    assert.deepEqual(
      documents.map((document) => ({
        prev: document.frontmatter.okv.prev,
        next: document.frontmatter.okv.next,
      })),
      [
        { prev: undefined, next: ids[1] },
        { prev: ids[0], next: ids[2] },
        { prev: ids[1], next: ids[3] },
        { prev: ids[2], next: undefined },
      ],
    );
  });

  it("preserves paths, coverage, and markdown bytes across repeated generation", () => {
    const first = generateDeckSourceSpans(loadDeck());
    const second = generateDeckSourceSpans(loadDeck());

    assert.deepEqual(
      first.map((document) => document.relativePath),
      second.map((document) => document.relativePath),
    );
    assert.deepEqual(
      first.map((document) => document.frontmatter.okv.anchor_ids),
      second.map((document) => document.frontmatter.okv.anchor_ids),
    );
    assert.deepEqual(first.map(renderSourceSpanMarkdown), second.map(renderSourceSpanMarkdown));
  });
});
