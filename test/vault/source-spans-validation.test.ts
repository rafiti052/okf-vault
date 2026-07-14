import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
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
  sourceSpanContentSha256,
  validateSourceSpanDocuments,
  type SourceSpanMarkdownDocument,
  type SourceSpanValidationInput,
} from "../../dist/vault/validation.js";
import type { SourceSpanIndex, SourceSpanProfile } from "../../dist/vault/manifest.js";
import type { SourceEnvelope } from "../../dist/vault/validation.js";

const ENVELOPE_ROOT = join(process.cwd(), "test", "fixtures", "envelopes");

interface ValidationFixture extends SourceSpanValidationInput {
  index: SourceSpanIndex;
  documents: SourceSpanMarkdownDocument[];
  envelope: SourceEnvelope;
}

function loadEnvelope(relativePath: string): SourceEnvelope {
  return JSON.parse(readFileSync(join(ENVELOPE_ROOT, relativePath), "utf8")) as SourceEnvelope;
}

function buildFixture(
  profile: SourceSpanProfile,
  envelope: SourceEnvelope,
  generated: readonly SourceSpanDocument[],
): ValidationFixture {
  const documents = generated.map((document) => ({
    relativePath: document.relativePath,
    content: renderSourceSpanMarkdown(document),
  }));
  const index: SourceSpanIndex = {
    schema_version: "okf-source-spans/1.0.0",
    profile,
    default_expansion: { previous: 1, next: 1 },
    spans: generated.map((document, position) => ({
      id: document.frontmatter.okv.span_id,
      path: document.relativePath,
      sha256: sourceSpanContentSha256(documents[position]!.content),
      profile,
      sequence: document.frontmatter.okv.sequence,
      anchor_ids: [...document.frontmatter.okv.anchor_ids],
      ...(document.frontmatter.okv.prev === undefined
        ? {}
        : { prev_id: document.frontmatter.okv.prev }),
      ...(document.frontmatter.okv.next === undefined
        ? {}
        : { next_id: document.frontmatter.okv.next }),
    })),
  };
  return { profile, envelope, index, documents };
}

function fixtureFor(profile: SourceSpanProfile): ValidationFixture {
  switch (profile) {
    case "article": {
      const envelope = loadEnvelope("article/span-sections.json");
      return buildFixture(profile, envelope, generateArticleSpanDocuments(envelope));
    }
    case "video": {
      const envelope = loadEnvelope("video/span-generation-gold.json");
      return buildFixture(profile, envelope, generateVideoSourceSpans(envelope));
    }
    case "panel": {
      const envelope = loadEnvelope("panel/accepted-01.json");
      return buildFixture(profile, envelope, generatePanelSourceSpans(envelope));
    }
    case "deck": {
      const envelope = loadEnvelope("deck/span-generation.json");
      return buildFixture(profile, envelope, generateDeckSourceSpans(envelope));
    }
  }
}

function cloneFixture(profile: SourceSpanProfile): ValidationFixture {
  return structuredClone(fixtureFor(profile));
}

function replaceDocumentContent(
  fixture: ValidationFixture,
  position: number,
  content: string,
): void {
  const current = fixture.documents[position];
  assert.ok(current);
  fixture.documents[position] = { ...current, content };
  fixture.index.spans[position]!.sha256 = sourceSpanContentSha256(content);
}

function issueCodes(fixture: SourceSpanValidationInput): string[] {
  return validateSourceSpanDocuments(fixture).map((entry) => entry.code);
}

describe("source-span validator accepted profile integration", () => {
  it("accepts generated article, video, panel, and deck documents with matching indexes", () => {
    for (const profile of ["article", "video", "panel", "deck"] as const) {
      assert.deepEqual(
        validateSourceSpanDocuments(fixtureFor(profile)),
        [],
        `${profile} generator output should satisfy the shared validator`,
      );
    }
  });

  it("exposes the validator through the established validation surface", () => {
    assert.equal(typeof validateSourceSpanDocuments, "function");
    assert.equal(SOURCE_SPAN_VALIDATION_CODES.hashMismatch, "SOURCE_SPAN_HASH_MISMATCH");
  });
});

describe("source-span document and index validation", () => {
  it("fails closed when the index or an indexed document is missing", () => {
    const missingIndex = fixtureFor("article");
    const { index: _index, ...withoutIndex } = missingIndex;
    assert.ok(issueCodes(withoutIndex).includes(SOURCE_SPAN_VALIDATION_CODES.missing));

    const malformedIndex = cloneFixture("article");
    (malformedIndex as unknown as { index: null }).index = null;
    assert.ok(issueCodes(malformedIndex).includes(SOURCE_SPAN_VALIDATION_CODES.indexInvalid));

    const missingDocument = cloneFixture("article");
    missingDocument.documents.pop();
    assert.ok(issueCodes(missingDocument).includes(SOURCE_SPAN_VALIDATION_CODES.missing));
  });

  it("rejects unsafe, non-deterministic, and orphan document paths", () => {
    const unsafe = cloneFixture("article");
    unsafe.documents[0]!.relativePath = "../references/sources/escape/span-001.md";
    assert.ok(issueCodes(unsafe).includes(SOURCE_SPAN_VALIDATION_CODES.pathInvalid));

    const wrongPath = cloneFixture("article");
    wrongPath.documents[0]!.relativePath = wrongPath.documents[0]!.relativePath.replace(
      "span-001.md",
      "span-999.md",
    );
    assert.ok(issueCodes(wrongPath).includes(SOURCE_SPAN_VALIDATION_CODES.pathInvalid));
    assert.ok(issueCodes(wrongPath).includes(SOURCE_SPAN_VALIDATION_CODES.indexMismatch));
  });

  it("detects byte-level hash drift", () => {
    const fixture = cloneFixture("video");
    fixture.documents[0]!.content += "tampered\n";

    const codes = issueCodes(fixture);
    assert.ok(codes.includes(SOURCE_SPAN_VALIDATION_CODES.hashMismatch));
  });

  it("rejects malformed frontmatter, unknown metadata, and an empty body", () => {
    const malformed = cloneFixture("article");
    replaceDocumentContent(
      malformed,
      0,
      malformed.documents[0]!.content.replace("type: Source Span", "type: ["),
    );
    assert.ok(issueCodes(malformed).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));

    const unknown = cloneFixture("article");
    replaceDocumentContent(
      unknown,
      0,
      unknown.documents[0]!.content.replace(
        "  sequence: 1",
        "  sequence: 1\n  raw_text: forbidden",
      ),
    );
    assert.ok(issueCodes(unknown).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));

    const emptyBody = cloneFixture("article");
    replaceDocumentContent(
      emptyBody,
      0,
      emptyBody.documents[0]!.content.replace(/\n---\n\n[\s\S]*$/u, "\n---\n\n"),
    );
    assert.ok(issueCodes(emptyBody).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));
  });

  it("rejects source identity and deterministic span-ID drift", () => {
    const identityDrift = cloneFixture("article");
    replaceDocumentContent(
      identityDrift,
      0,
      identityDrift.documents[0]!.content.replace(
        `source_key: ${identityDrift.envelope.source_key}`,
        "source_key: local:/tmp/other.md",
      ),
    );
    assert.ok(issueCodes(identityDrift).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));

    const idDrift = cloneFixture("article");
    replaceDocumentContent(
      idDrift,
      0,
      idDrift.documents[0]!.content.replace(/span_id: \S+/u, "span_id: span-001-wrong"),
    );
    assert.ok(issueCodes(idDrift).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));

    const malformedEnvelope = cloneFixture("article");
    malformedEnvelope.envelope.content_sha256 = "not-a-sha256";
    assert.doesNotThrow(() => validateSourceSpanDocuments(malformedEnvelope));
    assert.ok(issueCodes(malformedEnvelope).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid));
  });

  it("rejects unknown index and index-entry fields", () => {
    const unknownIndexField = cloneFixture("article");
    (
      unknownIndexField.index as SourceSpanIndex & {
        raw_text?: string;
      }
    ).raw_text = "forbidden";
    assert.ok(issueCodes(unknownIndexField).includes(SOURCE_SPAN_VALIDATION_CODES.indexInvalid));

    const unknownEntryField = cloneFixture("article");
    (
      unknownEntryField.index.spans[0] as SourceSpanIndex["spans"][number] & {
        text?: string;
      }
    ).text = "forbidden";
    assert.ok(issueCodes(unknownEntryField).includes(SOURCE_SPAN_VALIDATION_CODES.indexInvalid));
  });
});

describe("source-span bounded sibling validation", () => {
  it("rejects broken, skipped, and cyclic sibling links", () => {
    const brokenIndex = cloneFixture("article");
    brokenIndex.index.spans[0]!.next_id = brokenIndex.index.spans[2]!.id;
    assert.ok(issueCodes(brokenIndex).includes(SOURCE_SPAN_VALIDATION_CODES.siblingInvalid));

    const brokenDocument = cloneFixture("article");
    replaceDocumentContent(
      brokenDocument,
      1,
      brokenDocument.documents[1]!.content.replace(
        `prev: ${brokenDocument.index.spans[0]!.id}`,
        `prev: ${brokenDocument.index.spans[2]!.id}`,
      ),
    );
    assert.ok(issueCodes(brokenDocument).includes(SOURCE_SPAN_VALIDATION_CODES.siblingInvalid));

    const duplicateSequence = cloneFixture("article");
    duplicateSequence.index.spans[1]!.sequence = 1;
    assert.ok(issueCodes(duplicateSequence).includes(SOURCE_SPAN_VALIDATION_CODES.indexInvalid));
  });

  it("rejects expansion beyond one previous and one next span", () => {
    const fixture = cloneFixture("deck");
    (fixture.index.default_expansion as { previous: number; next: number }).previous = 2;

    assert.ok(issueCodes(fixture).includes(SOURCE_SPAN_VALIDATION_CODES.expansionUnbounded));
  });
});

describe("source-span profile-specific coverage and counterexamples", () => {
  it("fails unresolved required anchors for every profile with the stable issue code", () => {
    const counterexamples: Array<{
      profile: SourceSpanProfile;
      anchor: SourceEnvelope["anchors"][number];
    }> = [
      {
        profile: "article",
        anchor: { id: "article-uncovered", kind: "text", text: "Uncovered article evidence." },
      },
      {
        profile: "video",
        anchor: {
          id: "video-uncovered",
          kind: "timestamp",
          timestamp: "00:10:00",
          text: "Uncovered video evidence.",
        },
      },
      {
        profile: "panel",
        anchor: {
          id: "panel-uncovered",
          kind: "speaker",
          speaker: "Guest",
          text: "Uncovered panel evidence.",
        },
      },
      {
        profile: "deck",
        anchor: {
          id: "deck-uncovered",
          kind: "slide",
          slide_number: 99,
          text: "Uncovered deck evidence.",
        },
      },
    ];

    for (const { profile, anchor } of counterexamples) {
      const fixture = cloneFixture(profile);
      fixture.envelope.anchors.push(anchor);
      assert.ok(
        issueCodes(fixture).includes(SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved),
        `${profile} should reject uncovered anchors`,
      );
    }
  });

  it("rejects unresolved and ambiguously covered document anchors", () => {
    const unresolved = cloneFixture("article");
    replaceDocumentContent(
      unresolved,
      0,
      unresolved.documents[0]!.content.replace("- anchor-001", "- missing-anchor"),
    );
    unresolved.index.spans[0]!.anchor_ids = ["missing-anchor"];
    assert.ok(issueCodes(unresolved).includes(SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved));

    const ambiguous = cloneFixture("article");
    replaceDocumentContent(
      ambiguous,
      1,
      ambiguous.documents[1]!.content.replace("- anchor-002", "- anchor-001"),
    );
    ambiguous.index.spans[1]!.anchor_ids = ["anchor-001"];
    assert.ok(issueCodes(ambiguous).includes(SOURCE_SPAN_VALIDATION_CODES.anchorAmbiguous));
  });

  it("rejects profile anchors bound to the wrong timestamp, speaker, or slide metadata", () => {
    const video = cloneFixture("video");
    video.envelope.anchors[0]!.timestamp = "00:00:06";
    assert.ok(issueCodes(video).includes(SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved));

    const panel = cloneFixture("panel");
    panel.envelope.anchors[0]!.speaker = "Different Speaker";
    assert.ok(issueCodes(panel).includes(SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved));

    const deck = cloneFixture("deck");
    deck.envelope.anchors[0]!.slide_number = 2;
    assert.ok(issueCodes(deck).includes(SOURCE_SPAN_VALIDATION_CODES.anchorUnresolved));
  });

  it("enforces each profile's required metadata shape", () => {
    const cases: Array<{ profile: SourceSpanProfile; mutate: (content: string) => string }> = [
      {
        profile: "article",
        mutate: (content) => content.replace("profile: article", "profile: video"),
      },
      {
        profile: "video",
        mutate: (content) => content.replace(/^timestamp: .*\n/mu, ""),
      },
      {
        profile: "panel",
        mutate: (content) => content.replace(/^ {2}speaker: .*\n/mu, ""),
      },
      {
        profile: "deck",
        mutate: (content) => content.replace(/^ {2}slide_number: .*\n/mu, ""),
      },
    ];

    for (const { profile, mutate } of cases) {
      const fixture = cloneFixture(profile);
      replaceDocumentContent(fixture, 0, mutate(fixture.documents[0]!.content));
      assert.ok(
        issueCodes(fixture).includes(SOURCE_SPAN_VALIDATION_CODES.documentInvalid),
        `${profile} should reject malformed profile metadata`,
      );
    }
  });
});
