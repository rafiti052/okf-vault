# Article Conversion Profile

Convert a normalized **source envelope** into an **Article Note** that satisfies the [note contract](../note-contract.md). This profile is topic-agnostic: do not inject domain taxonomy, required themes, or corpus-specific vocabulary into output.

## Input

- A validated source envelope with `content_type` indicating long-form article or document text.
- Envelope field definitions: [source-envelope.md](../source-envelope.md).

## Output

- One staged Markdown file under `<vault-root>/.okf-vault/tmp/<run-id>/notes/<stable-slug>.md`.
- `type: Article Note` with all required frontmatter and sections from the note contract.

## Durable source-span behavior

- The helper creates ordered source-span reference documents under `references/sources/<source-slug>/span-XXX.md` from text-bearing envelope anchors.
- Each anchored span preserves its anchor ID and may carry the nearest preceding Markdown `heading` plus the anchor label as `parent_label` when those values are available.
- When no text-bearing anchor exists, one span may use non-empty `normalized_text`; an empty envelope cannot produce article spans.
- Span sequence follows envelope anchor order. Immediate `prev` and `next` links support bounded hydration without turning headings into a separately traversable hierarchy.
- After a semantic note is selected, each claim anchor hydrates its exact article span plus at most one previous and one next span. Article span text is not ranked during first-hop retrieval.

## Conversion workflow

1. **Read envelope** — Use `title`, `normalized_text`, and `anchors` only; do not fetch additional content.
2. **Identify material claims** — Extract factual statements supported by envelope anchors. Skip decorative or navigational text.
3. **Assign claim IDs** — Number claims sequentially as `claim-001`, `claim-002`, … without gaps or duplicates.
4. **Bind anchors** — Every claim MUST list at least one anchor ID present in the envelope `anchors` array.
5. **Write sections** — Produce `# Summary`, `# Key Claims`, `# Citations`, and `# Evidence` in that order.
6. **Copy provenance** — Set frontmatter `source` from envelope identity fields (`source_key`, `kind`, `origin`, `content_sha256`) and record `acquired_at` in UTC ISO-8601.
7. **Set contract_version** — MUST match the vault manifest `note_contract_version` (currently `okf-note-contract/1.0.0`).

## Section requirements

| Section        | Requirement                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `# Summary`    | Concise overview grounded in envelope content; no facts absent from anchors. |
| `# Key Claims` | Bullets referencing `claim-NNN` IDs declared in frontmatter `claims`.        |
| `# Citations`  | Pointers to the source (`origin`, title, or canonical URI).                  |
| `# Evidence`   | Quotes or tight paraphrases tied to anchor IDs (e.g. `[anchor-001]`).        |

## Claim and anchor rules

- Claim IDs MUST match `claim-NNN` format (three-digit zero-padded decimal).
- Every `# Key Claims` bullet MUST include a resolvable `claim-NNN` reference.
- Do **not** invent claims, statistics, names, or conclusions absent from envelope anchors or `normalized_text`.
- Do **not** reference anchor IDs that are not listed on the corresponding claim in frontmatter.

## Pre-conversion failure modes

Stop before conversion when normalization pre-check fails. Curator-visible conditions:

| Condition                                           | Error code (normalization)                        | Remediation                                           |
| --------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------- |
| Envelope missing required fields or invalid hash    | `ENVELOPE_MISSING_FIELD`, `ENVELOPE_INVALID_HASH` | Re-run acquisition; verify export completeness.       |
| Unsupported envelope contract version               | `ENVELOPE_UNSUPPORTED_VERSION`                    | Upgrade helper or re-normalize with current contract. |
| Empty or unusable `normalized_text` with no anchors | _(blocked at acquire)_                            | Re-export source; ensure text extraction succeeded.   |
| Provider credential fields in envelope              | `ENVELOPE_CREDENTIAL_FIELD`                       | Redact secrets; re-normalize.                         |

When article structure is incomplete (e.g., empty body, no extractable anchors), emit `validation_failed` with rationale, offer **retry**, **skip with reason**, or **abort** — do not stage a note.

## Post-conversion validation

Run helper `validate-staged` with the envelope JSON path. Common failure codes:

| Code                        | Meaning                                              |
| --------------------------- | ---------------------------------------------------- |
| `ANCHOR_RESOLUTION_FAILED`  | Claim references an anchor ID missing from envelope. |
| `UNRESOLVED_CLAIM`          | `# Key Claims` cites undeclared claim ID.            |
| `MISSING_SECTION`           | Required section heading absent.                     |
| `CONTRACT_VERSION_MISMATCH` | Note `contract_version` differs from vault manifest. |

Fix conversion output and re-validate; do not commit until exit 0.

## Semantic acceptance

Compare staged output against [gold notes](../../../../../test/fixtures/notes/gold/article/) before declaring ingest success for a new article profile revision. Gold notes demonstrate acceptable claim density, evidence linkage, and topic-neutral wording.
