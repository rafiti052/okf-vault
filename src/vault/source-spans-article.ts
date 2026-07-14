import {
  createSourceSpanDocument,
  createSourceSpanId,
  createSourceSpanSiblingMetadata,
  type SourceSpanDocument,
} from "./source-spans.js";

export interface ArticleSourceAnchor {
  id: string;
  kind: string;
  label?: string;
  text?: string;
}

export interface ArticleSourceEnvelope {
  source_key: string;
  content_sha256: string;
  canonical_uri?: string;
  title: string;
  normalized_text: string;
  anchors: readonly ArticleSourceAnchor[];
}

interface ArticleSpanSeed {
  body: string;
  anchorIds: string[];
  anchorKind?: string;
  heading?: string;
  parentLabel?: string;
}

interface HeadingContext {
  heading?: string;
  nextOffset: number;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function findHeading(normalizedText: string, spanText: string, fromOffset = 0): HeadingContext {
  const source = normalizeLineEndings(normalizedText);
  const needle = normalizeLineEndings(spanText).trim();
  const spanOffset = source.indexOf(needle, fromOffset);
  if (spanOffset < 0) {
    return { nextOffset: fromOffset };
  }

  const headingPattern = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu;
  let heading: string | undefined;
  for (
    let match = headingPattern.exec(source);
    match !== null;
    match = headingPattern.exec(source)
  ) {
    if (match.index > spanOffset) {
      break;
    }
    heading = optionalTrimmed(match[1]);
  }
  return {
    ...(heading !== undefined ? { heading } : {}),
    nextOffset: spanOffset + needle.length,
  };
}

function createArticleSpanSeeds(envelope: ArticleSourceEnvelope): ArticleSpanSeed[] {
  const anchoredSeeds: ArticleSpanSeed[] = [];
  let searchOffset = 0;
  for (const anchor of envelope.anchors) {
    const body = optionalTrimmed(anchor.text);
    if (body === undefined) {
      continue;
    }
    const anchorKind = optionalTrimmed(anchor.kind);
    const headingContext = findHeading(envelope.normalized_text, body, searchOffset);
    searchOffset = headingContext.nextOffset;
    const parentLabel = optionalTrimmed(anchor.label);
    anchoredSeeds.push({
      body,
      anchorIds: [anchor.id],
      ...(anchorKind !== undefined ? { anchorKind } : {}),
      ...(headingContext.heading !== undefined ? { heading: headingContext.heading } : {}),
      ...(parentLabel !== undefined ? { parentLabel } : {}),
    });
  }

  if (anchoredSeeds.length > 0) {
    return anchoredSeeds;
  }

  const body = optionalTrimmed(envelope.normalized_text);
  if (body === undefined) {
    throw new Error("Article envelope requires normalized_text or at least one text anchor");
  }
  const heading = findHeading(body, body).heading;
  return [
    {
      body,
      anchorIds: [],
      ...(heading !== undefined ? { heading } : {}),
    },
  ];
}

/** Generates ordered, deterministic source-span documents for an article envelope. */
export function generateArticleSpanDocuments(
  envelope: ArticleSourceEnvelope,
): SourceSpanDocument[] {
  const seeds = createArticleSpanSeeds(envelope);
  const spanIds = seeds.map((_, index) =>
    createSourceSpanId(envelope.source_key, envelope.content_sha256, "article", index + 1),
  );
  const resource = optionalTrimmed(envelope.canonical_uri);

  return seeds.map((seed, index) => {
    const sequence = index + 1;
    const context = seed.heading ?? seed.parentLabel ?? `span ${sequence}`;
    return createSourceSpanDocument({
      sourceKey: envelope.source_key,
      contentSha256: envelope.content_sha256,
      profile: "article",
      sequence,
      anchorIds: seed.anchorIds,
      ...createSourceSpanSiblingMetadata(spanIds, index),
      title: `${envelope.title.trim()} — span ${sequence}`,
      description: `Article evidence from ${context}.`,
      body: seed.body,
      ...(resource !== undefined ? { resource } : {}),
      ...(seed.anchorKind !== undefined ? { anchorKind: seed.anchorKind } : {}),
      ...(seed.heading !== undefined ? { heading: seed.heading } : {}),
      ...(seed.parentLabel !== undefined ? { parentLabel: seed.parentLabel } : {}),
    });
  });
}
