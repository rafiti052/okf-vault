# Video Transcript Conversion Profile

Convert a normalized **source envelope** with timestamped transcript segments into a **Video Transcript Note** that satisfies the [note contract](../note-contract.md). This profile is topic-agnostic: do not inject domain taxonomy, required themes, or corpus-specific vocabulary into output.

## Input

- A validated transcript envelope with timestamp markers for material segments.
- Envelope field definitions: [source-envelope.md](../source-envelope.md).
- Local and Granola normalization expectations: [normalization.md](../normalization.md).

## Output

- One staged Markdown file under `.okf-vault/tmp/<run-id>/notes/<stable-slug>.md`.
- `type: Video Transcript Note` with all required frontmatter and sections from the note contract.

## Panel vs video typing (curator guidance)

When only transcript text is available and classification is ambiguous:

| Signal in envelope or source                   | Prefer profile                                |
| ---------------------------------------------- | --------------------------------------------- |
| Single narrator or presenter                   | **Video**                                     |
| Timestamp segments without multi-speaker turns | **Video**                                     |
| Multiple distinct speakers in dialogue         | **Panel**                                     |
| Named panelists with alternating turns         | **Panel**                                     |
| Local `.vtt` / `.srt` with cue timestamps only | **Video**                                     |
| Granola meeting export with participant labels | **Panel** unless curator declares video recap |

When uncertain, ask the curator to declare `panel` or `video` before conversion. Do not invent timestamps or segment boundaries.

## Pre-conversion checks (normalization contract)

| Check                                             | Error code                                        |
| ------------------------------------------------- | ------------------------------------------------- |
| Envelope missing required fields or invalid hash  | `ENVELOPE_MISSING_FIELD`, `ENVELOPE_INVALID_HASH` |
| No timestamp anchors for a non-trivial transcript | _(blocked at acquire)_                            |

Local video transcripts (`kind: local`) MAY proceed without Drive or Granola credentials when timestamp anchors are present.

## Conversion workflow

1. **Read envelope** — Use `title`, `normalized_text`, and `anchors`; do not fetch additional content.
2. **Collect timestamp anchors** — Order `kind: timestamp` anchors by `timestamp` value when multiple exist.
3. **Identify material claims** — Extract factual statements supported by timestamp anchors.
4. **Assign claim IDs** — Sequential `claim-NNN` identifiers without gaps or duplicates.
5. **Bind anchors** — Every claim MUST list at least one `timestamp-*` anchor ID present in the envelope.
6. **Anchor claims in output** — Each `# Key Claims` bullet MUST trace to a timestamp anchor whose `timestamp` value appears in the envelope.
7. **Write sections** — Produce `# Summary`, `# Key Claims`, `# Citations`, and `# Evidence` in that order.
8. **Copy provenance** — Set frontmatter `source` from envelope identity fields; set `contract_version` to vault manifest value.

## Section requirements

| Section        | Requirement                                                                          |
| -------------- | ------------------------------------------------------------------------------------ |
| `# Summary`    | Concise overview grounded in envelope content.                                       |
| `# Key Claims` | Bullets referencing `claim-NNN` IDs; each claim cites a resolvable timestamp anchor. |
| `# Citations`  | Pointers to the source (`origin`, title, or canonical URI).                          |
| `# Evidence`   | Quotes or tight paraphrases tied to timestamp anchor IDs.                            |

## Timestamp fidelity rules

- Material claims MUST map to transcript anchors rather than undifferentiated paraphrase blocks.
- Every `# Key Claims` entry MUST cite a `claim-NNN` whose anchors resolve to envelope timestamps.
- Do **not** invent timestamps, segment text, or claims beyond the latest timestamp present in the envelope.
- Do **not** reference `timestamp-*` anchor IDs absent from the envelope (validation fails with `ANCHOR_RESOLUTION_FAILED`).

## Partial-marker fallback behavior

### Paragraph-granularity timestamps

When the envelope provides timestamps only at paragraph or cue boundaries (not per sentence):

1. Bind each material claim to the **nearest preceding** paragraph-level `timestamp-*` anchor that covers the claim text in `normalized_text`.
2. In `# Evidence`, cite that anchor ID and reproduce the paragraph excerpt; do not fabricate finer-grained times.
3. If a claim spans two paragraph anchors, split into separate claims or bind to the anchor whose `text` field contains the supporting excerpt.
4. Record coarse timing in `# Summary` when sub-minute precision is unavailable (e.g. "timestamps at paragraph boundaries only").

| Envelope condition                    | Conversion behavior                                                                         | Curator escalation                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Paragraph timestamps only             | Use nearest preceding anchor; no invented sub-segment times.                                | Accept coarse anchors or re-export finer cues. |
| Timestamps end before claimed segment | Stop; do not stage note with out-of-range anchors.                                          | Extend source export or trim claims.           |
| Speakers present without timestamps   | Prefer panel profile; if curator insists on video, bind to any timestamp anchors available. | Reclassify or re-acquire timestamps.           |
| No timestamps                         | Stop before conversion.                                                                     | Retry normalization or skip with reason.       |

When fallback applies, document granularity limits in `# Summary` without inventing missing timestamps.

## Post-conversion validation

Run helper `validate-staged` with the envelope JSON path. Common failure codes:

| Code                        | Meaning                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `ANCHOR_RESOLUTION_FAILED`  | Claim references timestamp anchor ID missing from envelope. |
| `UNRESOLVED_CLAIM`          | `# Key Claims` cites undeclared claim ID.                   |
| `MISSING_SECTION`           | Required section heading absent.                            |
| `CONTRACT_VERSION_MISMATCH` | Note `contract_version` differs from vault manifest.        |

Fix conversion output and re-validate; do not commit until exit 0.

## Semantic acceptance

Compare staged output against [gold notes](../../../../test/fixtures/notes/gold/video/) before declaring ingest success for a new video profile revision. Gold notes demonstrate timestamp anchor binding, paragraph-granularity fallback, and topic-neutral wording.
