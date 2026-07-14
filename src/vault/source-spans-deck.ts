import {
  createSourceSpanDocument,
  createSourceSpanId,
  createSourceSpanSiblingMetadata,
  type SourceSpanDocument,
  type SourceSpanDocumentInput,
} from "./source-spans.js";
import type { DeckSlide, SourceAnchor, SourceEnvelope } from "./validation.js";

interface DeckSpanUnit {
  anchorIds: string[];
  anchorKind: "slide" | "speaker_note";
  body: string;
  description: string;
  parentLabel: string;
  slideNumber: number;
  tags: string[];
  title: string;
}

function requireText(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return normalized;
}

function anchorsForSlide(
  anchors: readonly SourceAnchor[],
  slideNumber: number,
  kind: DeckSpanUnit["anchorKind"],
): string[] {
  return anchors
    .filter((anchor) => anchor.slide_number === slideNumber && anchor.kind === kind)
    .map((anchor) => anchor.id);
}

function slideLabel(slide: DeckSlide): string {
  const title = slide.title?.trim();
  return title === undefined || title.length === 0
    ? `Slide ${slide.number}`
    : `Slide ${slide.number}: ${title}`;
}

function assertNormalizedDeck(envelope: SourceEnvelope): DeckSlide[] {
  if (envelope.deck_complete !== true) {
    throw new Error("deck envelope must have deck_complete: true");
  }
  if (envelope.slides === undefined || envelope.slides.length === 0) {
    throw new Error("deck envelope must include at least one slide");
  }

  for (const [index, slide] of envelope.slides.entries()) {
    const expectedNumber = index + 1;
    if (slide.number !== expectedNumber) {
      throw new Error(`deck slides must be ordered without gaps; expected slide ${expectedNumber}`);
    }
    requireText(slide.text, `slide ${slide.number} text`);
    if (anchorsForSlide(envelope.anchors, slide.number, "slide").length === 0) {
      throw new Error(`slide ${slide.number} must have at least one slide anchor`);
    }
    if (
      slide.speaker_notes.trim().length > 0 &&
      anchorsForSlide(envelope.anchors, slide.number, "speaker_note").length === 0
    ) {
      throw new Error(`slide ${slide.number} speaker notes must have a speaker_note anchor`);
    }
  }

  return envelope.slides;
}

function createDeckSpanUnits(
  envelope: SourceEnvelope,
  slides: readonly DeckSlide[],
): DeckSpanUnit[] {
  const deckTitle = requireText(envelope.title, "deck title");
  return slides.flatMap((slide): DeckSpanUnit[] => {
    const label = slideLabel(slide);
    const slideUnit: DeckSpanUnit = {
      anchorIds: anchorsForSlide(envelope.anchors, slide.number, "slide"),
      anchorKind: "slide",
      body: slide.text,
      description: `Visible source evidence from slide ${slide.number} of ${deckTitle}.`,
      parentLabel: deckTitle,
      slideNumber: slide.number,
      tags: ["deck", "slide", "source-span"],
      title: `${deckTitle} — ${label}`,
    };

    if (slide.speaker_notes.trim().length === 0) {
      return [slideUnit];
    }

    return [
      slideUnit,
      {
        anchorIds: anchorsForSlide(envelope.anchors, slide.number, "speaker_note"),
        anchorKind: "speaker_note",
        body: slide.speaker_notes,
        description: `Speaker-note source evidence paired with slide ${slide.number} of ${deckTitle}.`,
        parentLabel: label,
        slideNumber: slide.number,
        tags: ["deck", "source-span", "speaker-note"],
        title: `${deckTitle} — Slide ${slide.number} speaker notes`,
      },
    ];
  });
}

/** Generates ordered slide and speaker-note evidence documents from a normalized deck envelope. */
export function generateDeckSourceSpans(envelope: SourceEnvelope): SourceSpanDocument[] {
  const slides = assertNormalizedDeck(envelope);
  const units = createDeckSpanUnits(envelope, slides);
  const spanIds = units.map((_, index) =>
    createSourceSpanId(envelope.source_key, envelope.content_sha256, "deck", index + 1),
  );

  return units.map((unit, index) => {
    const input: SourceSpanDocumentInput = {
      sourceKey: envelope.source_key,
      contentSha256: envelope.content_sha256,
      profile: "deck",
      sequence: index + 1,
      ...unit,
      ...createSourceSpanSiblingMetadata(spanIds, index),
      ...(envelope.canonical_uri.trim().length > 0
        ? { resource: envelope.canonical_uri.trim() }
        : {}),
    };
    return createSourceSpanDocument(input);
  });
}
