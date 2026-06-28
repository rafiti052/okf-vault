---
type: Video Transcript Note
title: Training Recap Video
description: Gold video note demonstrating paragraph-granularity timestamp fallback.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/sources/training-recap.vtt
  kind: local
  origin: /tmp/sources/training-recap.vtt
  content_sha256: "f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4f4"
  acquired_at: 2026-06-19T12:00:00.000Z
claims:
  - id: claim-001
    text: The training session objectives appear in the first paragraph segment.
    anchors:
      - timestamp-00:02:00
  - id: claim-002
    text: Exercises completed by participants appear in the second paragraph segment.
    anchors:
      - timestamp-00:06:00
---

# Summary

Training recap with paragraph-boundary timestamps only; claims bind to nearest preceding cue anchors.

# Key Claims

- Training objectives are covered in paragraph one (claim-001).
- Exercises are covered in paragraph two (claim-002).

# Citations

- Training Recap Video (`file:///tmp/sources/training-recap.vtt`).

# Evidence

> Paragraph one covers objectives for the training session. [timestamp-00:02:00]

> Paragraph two covers exercises participants completed. [timestamp-00:06:00]
