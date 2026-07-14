import {
  createSourceSpanDocument,
  createSourceSpanId,
  createSourceSpanSiblingMetadata,
  type SourceSpanDocument,
} from "./source-spans.js";
import type { SourceAnchor, SourceEnvelope } from "./validation.js";

interface PanelTranscriptTurn {
  anchorIds: string[];
  text: string;
  speaker?: string;
  timestamp?: string;
}

function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function anchorText(anchor: SourceAnchor): string | undefined {
  return optionalText(anchor.text);
}

function speakerForAnchor(anchor: SourceAnchor): string | undefined {
  return (
    optionalText(anchor.speaker) ??
    (anchor.kind === "speaker" ? optionalText(anchor.label) : undefined)
  );
}

function speakersMatch(speakerAnchor: SourceAnchor, timestampAnchor: SourceAnchor): boolean {
  const speakerMarker = speakerForAnchor(speakerAnchor);
  const timestampSpeaker = speakerForAnchor(timestampAnchor);
  return (
    speakerMarker === undefined ||
    timestampSpeaker === undefined ||
    speakerMarker === timestampSpeaker
  );
}

function turnFromSpeakerAnchor(anchor: SourceAnchor): PanelTranscriptTurn | undefined {
  const text = anchorText(anchor);
  if (text === undefined) {
    return undefined;
  }

  const speaker = speakerForAnchor(anchor);
  return {
    anchorIds: [anchor.id],
    text,
    ...(speaker !== undefined ? { speaker } : {}),
  };
}

function turnFromTimestampAnchor(
  anchor: SourceAnchor,
  speakerAnchor?: SourceAnchor,
): PanelTranscriptTurn | undefined {
  const text =
    anchorText(anchor) ?? (speakerAnchor === undefined ? undefined : anchorText(speakerAnchor));
  if (text === undefined) {
    return undefined;
  }

  const speaker =
    speakerForAnchor(anchor) ??
    (speakerAnchor === undefined ? undefined : speakerForAnchor(speakerAnchor));
  const timestamp = optionalText(anchor.timestamp);
  return {
    anchorIds: [...(speakerAnchor === undefined ? [] : [speakerAnchor.id]), anchor.id],
    text,
    ...(speaker !== undefined ? { speaker } : {}),
    ...(timestamp !== undefined ? { timestamp } : {}),
  };
}

function collectPanelTranscriptTurns(envelope: SourceEnvelope): PanelTranscriptTurn[] {
  const turns: PanelTranscriptTurn[] = [];
  let pendingSpeakerAnchor: SourceAnchor | undefined;

  for (const anchor of envelope.anchors) {
    if (anchor.kind === "speaker") {
      if (pendingSpeakerAnchor !== undefined) {
        const pendingTurn = turnFromSpeakerAnchor(pendingSpeakerAnchor);
        if (pendingTurn !== undefined) {
          turns.push(pendingTurn);
        }
      }
      pendingSpeakerAnchor = anchor;
      continue;
    }

    if (anchor.kind !== "timestamp") {
      continue;
    }

    if (pendingSpeakerAnchor !== undefined && !speakersMatch(pendingSpeakerAnchor, anchor)) {
      const pendingTurn = turnFromSpeakerAnchor(pendingSpeakerAnchor);
      if (pendingTurn !== undefined) {
        turns.push(pendingTurn);
      }
      pendingSpeakerAnchor = undefined;
    }

    const timestampTurn = turnFromTimestampAnchor(anchor, pendingSpeakerAnchor);
    if (timestampTurn !== undefined) {
      turns.push(timestampTurn);
    }
    pendingSpeakerAnchor = undefined;
  }

  if (pendingSpeakerAnchor !== undefined) {
    const pendingTurn = turnFromSpeakerAnchor(pendingSpeakerAnchor);
    if (pendingTurn !== undefined) {
      turns.push(pendingTurn);
    }
  }

  return turns;
}

function turnAnchorKind(turn: PanelTranscriptTurn): "timestamp-speaker" | "timestamp" | "speaker" {
  if (turn.timestamp !== undefined && turn.speaker !== undefined) {
    return "timestamp-speaker";
  }
  return turn.timestamp !== undefined ? "timestamp" : "speaker";
}

function renderPanelTurnBody(turn: PanelTranscriptTurn): string {
  const metadata: string[] = [];
  if (turn.speaker !== undefined) {
    metadata.push(`**Speaker:** ${turn.speaker}`);
  }
  if (turn.timestamp !== undefined) {
    metadata.push(`**Timestamp:** ${turn.timestamp}`);
  }
  return [...metadata, turn.text].join("\n\n");
}

function turnDescription(turn: PanelTranscriptTurn, sequence: number): string {
  const attribution = turn.speaker === undefined ? "" : ` by ${turn.speaker}`;
  const timing = turn.timestamp === undefined ? "" : ` at ${turn.timestamp}`;
  return `Panel transcript turn ${sequence}${attribution}${timing}.`;
}

/**
 * Generates ordered, speaker-aware source-span documents from a normalized panel envelope.
 * Envelope anchor order is authoritative; timestamps are metadata, not a sorting key.
 */
export function generatePanelSourceSpans(envelope: SourceEnvelope): SourceSpanDocument[] {
  const turns = collectPanelTranscriptTurns(envelope);
  if (turns.length === 0) {
    throw new Error("Panel source envelope contains no usable transcript turns");
  }

  const spanIds = turns.map((_, index) =>
    createSourceSpanId(envelope.source_key, envelope.content_sha256, "panel", index + 1),
  );
  const resource = optionalText(envelope.canonical_uri);
  const sourceTitle = optionalText(envelope.title) ?? "Panel transcript";

  return turns.map((turn, index) => {
    const sequence = index + 1;
    return createSourceSpanDocument({
      sourceKey: envelope.source_key,
      contentSha256: envelope.content_sha256,
      profile: "panel",
      sequence,
      anchorIds: turn.anchorIds,
      ...createSourceSpanSiblingMetadata(spanIds, index),
      ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
      anchorKind: turnAnchorKind(turn),
      title: `${sourceTitle} — turn ${String(sequence).padStart(3, "0")}`,
      description: turnDescription(turn, sequence),
      body: renderPanelTurnBody(turn),
      ...(resource !== undefined ? { resource } : {}),
      ...(turn.timestamp !== undefined ? { timestamp: turn.timestamp } : {}),
      tags: ["source-span", "panel", "transcript"],
    });
  });
}
