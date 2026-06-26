# Panel Transcript Conversion Profile

Convert a normalized **source envelope** with speaker-attributed transcript segments into a **Panel Transcript Note** that satisfies the [note contract](../note-contract.md). This profile is topic-agnostic: do not inject domain taxonomy, required themes, or corpus-specific vocabulary into output.

## Input

- A validated transcript envelope with speaker and timestamp markers where the provider supplies them.
- Envelope field definitions: [source-envelope.md](../source-envelope.md).
- Granola normalization expectations: [normalization.md](../normalization.md).

## Output

- One staged Markdown file under `.okf-vault/tmp/<run-id>/notes/<stable-slug>.md`.
- `type: Panel Transcript Note` with all required frontmatter and sections from the note contract.

## Panel vs video typing (curator guidance)

When only transcript text is available and classification is ambiguous:

| Signal in envelope or source                          | Prefer profile                              |
| ----------------------------------------------------- | ------------------------------------------- |
| Multiple distinct speakers with dialogue turns        | **Panel**                                   |
| Single narrator or presenter; one primary voice       | **Video**                                   |
| Speaker labels present (`Speaker A`, named panelists) | **Panel**                                   |
| Timestamp-only segments without speaker turns         | **Video**                                   |
| Granola meeting with participant list                 | **Panel**                                   |
| Local `.txt` / `.vtt` export of a recorded talk       | **Video** unless speaker turns are explicit |

When uncertain, ask the curator to declare `panel` or `video` before conversion. Do not guess speaker roles or invent participant names.

## Pre-conversion checks (normalization contract)

| Check                                                         | Error code                                        |
| ------------------------------------------------------------- | ------------------------------------------------- |
| Granola panel profile selected; no speaker markers in anchors | `INCOMPLETE_TRANSCRIPT_SPEAKERS`                  |
| Envelope missing required fields or invalid hash              | `ENVELOPE_MISSING_FIELD`, `ENVELOPE_INVALID_HASH` |
| Empty or unusable `normalized_text` with no anchors           | _(blocked at acquire)_                            |

Local panel transcripts without provider IDs (`kind: local`) MAY proceed when speaker markers appear in `anchors` or when the curator accepts timestamp-only fallback (see below).

## Conversion workflow

1. **Read envelope** — Use `title`, `normalized_text`, and `anchors`; do not fetch additional content.
2. **Identify speakers** — Collect distinct `speaker` values from `kind: speaker` and timestamp anchors that include `speaker`.
3. **Identify material claims** — Extract factual statements supported by transcript anchors. Skip filler and procedural chatter unless materially informative.
4. **Assign claim IDs** — Sequential `claim-NNN` identifiers without gaps or duplicates.
5. **Bind anchors** — Every claim MUST list at least one anchor ID present in the envelope (`timestamp-*`, `speaker-*`, or combined markers).
6. **Attribute speakers in evidence** — When the envelope provides speaker labels, `# Evidence` entries MUST name the speaker and cite the anchor (e.g. `Speaker A [timestamp-00:02:15]`).
7. **Write sections** — Produce `# Summary`, `# Key Claims`, `# Citations`, and `# Evidence` in that order.
8. **Copy provenance** — Set frontmatter `source` from envelope identity fields; set `contract_version` to vault manifest value.

## Section requirements

| Section        | Requirement                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------- |
| `# Summary`    | Concise overview of the discussion; no facts absent from anchors.                             |
| `# Key Claims` | Bullets referencing `claim-NNN` IDs; attribute speakers when envelope supplies them.          |
| `# Citations`  | Pointers to the source (`origin`, title, or canonical URI).                                   |
| `# Evidence`   | **Required panel evidence section.** Quotes or tight paraphrases with speaker and anchor IDs. |

The panel-specific evidence section named in the note contract is `# Evidence`. Do not substitute a differently named heading.

## Speaker and timestamp fidelity rules

- When the envelope includes `speaker` on an anchor, material claims MUST bind to anchors carrying that speaker (or a timestamp anchor for the same turn).
- When timestamps are present, `# Key Claims` and `# Evidence` MUST cite the matching `timestamp-*` anchor for each attributed quote or paraphrase.
- Do **not** invent speakers, timestamps, dialogue, or conclusions absent from envelope anchors or `normalized_text`.
- Do **not** merge distinct speakers into undifferentiated paraphrase blocks when speaker markers exist.

## Partial-marker fallback behavior

| Envelope condition                                | Conversion behavior                                                                  | Curator escalation                                      |
| ------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| Timestamps present; speakers missing              | Bind claims to timestamp anchors only; omit speaker names in output.                 | Confirm panel vs video typing; re-export with speakers. |
| Speakers present; timestamps sparse               | Bind claims to `speaker-*` anchors; note time uncertainty in `# Evidence`.           | Accept or re-acquire finer timestamps.                  |
| Neither speakers nor timestamps                   | Stop before conversion (`INCOMPLETE_TRANSCRIPT_SPEAKERS` for Granola panel profile). | Retry normalization or skip with reason.                |
| Single-speaker segments with paragraph timestamps | Treat as video profile candidate unless curator confirms panel.                      | Reclassify to video or skip.                            |

When fallback applies, document the limitation briefly in `# Summary` without inventing missing metadata.

## Post-conversion validation

Run helper `validate-staged` with the envelope JSON path. Common failure codes:

| Code                        | Meaning                                                                  |
| --------------------------- | ------------------------------------------------------------------------ |
| `ANCHOR_RESOLUTION_FAILED`  | Claim references anchor ID missing from envelope (e.g. unknown speaker). |
| `UNRESOLVED_CLAIM`          | `# Key Claims` cites undeclared claim ID.                                |
| `MISSING_SECTION`           | Required section heading absent (including `# Evidence`).                |
| `CONTRACT_VERSION_MISMATCH` | Note `contract_version` differs from vault manifest.                     |

Fix conversion output and re-validate; do not commit until exit 0.

## Semantic acceptance

Compare staged output against [gold notes](../../../../../test/fixtures/notes/gold/panel/) before declaring ingest success for a new panel profile revision. Gold notes demonstrate speaker attribution, timestamp binding, and topic-neutral wording without invented participants.
