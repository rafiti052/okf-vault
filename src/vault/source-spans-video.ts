import type { SourceAnchor, SourceEnvelope } from "./validation.js";
import {
  createSourceSpanDocument,
  createSourceSpanId,
  createSourceSpanSiblingMetadata,
  type SourceSpanDocument,
} from "./source-spans.js";

export type VideoTranscriptEnvelope = Pick<
  SourceEnvelope,
  "source_key" | "content_sha256" | "canonical_uri" | "title" | "anchors"
>;

interface VideoTranscriptSegment {
  anchorId: string;
  label?: string;
  timestamp: string;
  text: string;
}

function requireSegmentField(value: string | undefined, field: string): string {
  const normalized = value?.trim();
  if (normalized === undefined || normalized.length === 0) {
    throw new Error(`Video timestamp segment ${field} must be non-empty`);
  }
  return normalized;
}

function optionalSegmentLabel(anchor: SourceAnchor): string | undefined {
  const label = anchor.label?.trim();
  return label === undefined || label.length === 0 ? undefined : label;
}

function timestampSegments(envelope: VideoTranscriptEnvelope): VideoTranscriptSegment[] {
  const timestampAnchors = envelope.anchors.filter((anchor) => anchor.kind === "timestamp");
  if (timestampAnchors.length === 0) {
    throw new Error("Video transcript envelope must include at least one timestamp anchor");
  }

  const seenAnchorIds = new Set<string>();
  return timestampAnchors.map((anchor) => {
    const anchorId = requireSegmentField(anchor.id, "anchor ID");
    const label = optionalSegmentLabel(anchor);
    if (seenAnchorIds.has(anchorId)) {
      throw new Error("Video timestamp anchor IDs must be unique");
    }
    seenAnchorIds.add(anchorId);

    return {
      anchorId,
      ...(label !== undefined ? { label } : {}),
      timestamp: requireSegmentField(anchor.timestamp, "timestamp"),
      text: requireSegmentField(anchor.text, "text"),
    };
  });
}

/**
 * Generates one durable source-span document per timestamp anchor.
 *
 * Envelope order is transcript order: timestamps are preserved rather than sorted or refined.
 */
export function generateVideoSourceSpans(envelope: VideoTranscriptEnvelope): SourceSpanDocument[] {
  const segments = timestampSegments(envelope);
  const spanIds = segments.map((_, index) =>
    createSourceSpanId(envelope.source_key, envelope.content_sha256, "video", index + 1),
  );

  return segments.map((segment, index) => {
    const sequence = index + 1;
    return createSourceSpanDocument({
      sourceKey: envelope.source_key,
      contentSha256: envelope.content_sha256,
      profile: "video",
      sequence,
      anchorIds: [segment.anchorId],
      anchorKind: "timestamp",
      title: `${envelope.title} — ${segment.label ?? segment.timestamp}`,
      description: `Transcript evidence at ${segment.timestamp}.`,
      body: segment.text,
      resource: envelope.canonical_uri,
      timestamp: segment.timestamp,
      tags: ["source-span", "transcript", "video"],
      ...createSourceSpanSiblingMetadata(spanIds, index),
    });
  });
}
