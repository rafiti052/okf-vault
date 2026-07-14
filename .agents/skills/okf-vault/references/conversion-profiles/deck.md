# Slide Deck Conversion Profile

Convert a normalized **source envelope** with ordered slides into a **Slide Deck Note** that satisfies the [note contract](../note-contract.md). Reconstruct narrative meaning — do not transcribe slides line-by-line. This profile is topic-agnostic: do not inject domain taxonomy or corpus-specific vocabulary into output.

## Input

- A validated deck envelope with ordered `slides`, slide/speaker anchors, and `deck_complete: true`.
- Envelope field definitions: [source-envelope.md](../source-envelope.md).

## Output

- One staged Markdown file under `<vault-root>/.okf-vault/tmp/<run-id>/notes/<stable-slug>.md`.
- `type: Slide Deck Note` with all required frontmatter, `# Evidence`, `# Narrative`, and `# Slide Coverage`.

## Durable source-span behavior

- The helper creates one `anchor_kind: slide` source span for every ordered slide and, when speaker notes are non-empty, a following `anchor_kind: speaker_note` span for that slide under `references/sources/<source-slug>/span-XXX.md`.
- Every deck span carries its `slide_number`. Slide spans use the deck title as `parent_label`; speaker-note spans use their paired slide label.
- Span order is slide text followed by that slide's optional speaker notes, then the next slide. Immediate `prev` and `next` links preserve this deterministic sequence without creating a separate deck hierarchy.
- After a semantic note is selected, a claim anchor hydrates its exact slide or speaker-note span plus at most one previous and one next span. Deck spans are not first-hop retrieval candidates.

## Pre-conversion checks (normalization contract)

Conversion MUST NOT start until deck normalization pre-checks pass. These align with [normalization.md](../normalization.md):

| Check                                                     | Error code                  |
| --------------------------------------------------------- | --------------------------- |
| `slides` array present; `deck_complete` is `true`         | `INCOMPLETE_DECK_BLOCKED`   |
| Slide numbers start at 1 with no gaps                     | `INCOMPLETE_DECK_SLIDE_GAP` |
| Each slide has `text`, `speaker_notes`, `image_available` | `INCOMPLETE_DECK_CONTENT`   |
| At least one anchor per slide in `anchors`                | `INCOMPLETE_DECK_CONTENT`   |

When any check fails, stop before `conversion_started`. Curator options: **retry extraction** (re-export with imagery and speaker notes), **skip source with recorded reason**, or **abort run**.

Additional curator-visible failure modes before conversion:

| Symptom                                               | Remediation                                                     |
| ----------------------------------------------------- | --------------------------------------------------------------- |
| Missing rendered slide images when required           | Re-acquire deck export; set `deck_complete: false` until fixed. |
| Speaker notes present in source but empty in envelope | Re-run normalization with speaker-note extraction enabled.      |
| Slide text truncated or out of order                  | Fix slide ordering in normalizer; verify gap-free numbering.    |

## Conversion workflow

1. **Verify deck completeness** — Confirm pre-checks above; abort if not satisfied.
2. **Read ordered slides** — Walk slides by `number` ascending; incorporate `speaker_notes` where non-empty.
3. **Identify material claims** — Extract facts supported by slide or speaker-note anchors only.
4. **Assign claim IDs** — Sequential `claim-NNN` identifiers; bind each to slide or `speaker_note` anchors.
5. **Preserve numbers and units** — Copy numeric tokens (percentages, currency, counts, units) exactly as they appear in envelope anchor text into `# Key Claims` or `# Narrative`.
6. **Write `# Narrative`** — Reconstruct the deck story across slides; reference claim IDs; avoid bullet-per-slide transcription.
7. **Write `# Slide Coverage`** — Table or list mapping **every** envelope slide number to `covered`, `partial`, or `excluded` with rationale for exclusions.
8. **Write standard sections** — `# Summary`, `# Key Claims`, `# Citations`, `# Evidence` per note contract.
9. **Copy provenance** — Mirror envelope identity into frontmatter `source`; set `contract_version` to vault manifest value.

## Narrative reconstruction rules

- `# Narrative` MUST synthesize flow across slides (intro → development → conclusion).
- Narrative claims MUST reference `claim-NNN` IDs whose frontmatter anchors resolve to `slide` or `speaker_note` kinds.
- Use speaker-note anchors when speaker notes contain material claims not visible on slide text.
- Do **not** invent slides, metrics, or conclusions absent from the envelope.

## Slide coverage rules

- `# Slide Coverage` MUST include every slide number from the envelope `slides` array.
- Status values: `covered`, `partial`, or `excluded` (with explicit rationale for `partial` / `excluded`).
- Do not omit slides to shorten output; incomplete coverage fails `DECK_COVERAGE_INCOMPLETE` validation.

## Fidelity rules

- Ordered coverage MUST match envelope slide list exactly.
- Speaker notes MUST appear in claims or narrative when the envelope includes non-empty `speaker_notes` and a matching `speaker_note` anchor.
- Numbers, units, and named entities MUST NOT be altered without explicit curator comment (prefer verbatim copy from anchors).
- No unsupported claims: every `claim-NNN` MUST trace to at least one envelope anchor.

## Post-conversion validation

Run helper `validate-staged` with the deck envelope JSON. Common failure codes:

| Code                            | Meaning                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `DECK_COVERAGE_INCOMPLETE`      | `# Slide Coverage` missing one or more envelope slide numbers. |
| `DECK_NARRATIVE_ANCHOR_MISSING` | Narrative claim lacks slide or speaker-note anchor binding.    |
| `DECK_SLIDE_MISSING`            | Coverage references a slide not in the envelope.               |
| `ANCHOR_RESOLUTION_FAILED`      | Claim anchor ID absent from envelope.                          |

Fix and re-validate; do not commit until exit 0.

## Semantic acceptance

Compare staged output against [gold notes](../../../../../test/fixtures/notes/gold/deck/) before declaring ingest success for a new deck profile revision. Gold notes demonstrate full slide coverage, speaker-note usage, preserved numeric tokens, and narrative reconstruction rather than transcription.
