# OKF Knowledge Vault — Note Contract

**Contract version:** `okf-note-contract/1.0.0`  
**OKF baseline:** [OKF v0.1](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)

This document is the authoritative note contract for source-derived concepts and topic maps. Provider-specific MCP tool names MUST NOT appear in note content or frontmatter.

## Allowed note types

| `type` value            | Source                             | Evidence section                                       |
| ----------------------- | ---------------------------------- | ------------------------------------------------------ |
| `Article Note`          | Article / long-form document       | `# Evidence`                                           |
| `Slide Deck Note`       | Slide deck                         | `# Evidence` plus `# Narrative` and `# Slide Coverage` |
| `Panel Transcript Note` | Panel discussion transcript        | `# Evidence`                                           |
| `Video Transcript Note` | Video transcript                   | `# Evidence`                                           |
| `Topic Map`             | Curation (not a source conversion) | _(no source evidence section)_                         |

Unknown `type` values fail validation.

## Required YAML frontmatter

Every concept note (all types except reserved OKF files) MUST include:

```yaml
---
type: <allowed type>
title: <non-empty string>
description: <non-empty string>
contract_version: okf-note-contract/1.0.0
source:
  source_key: <stable identity>
  kind: local | google_drive | granola
  origin: <canonical locator>
  content_sha256: <64-char lowercase hex>
  acquired_at: <UTC ISO-8601>
tags: [] # optional, array of strings
resource: <uri> # optional
timestamp: <UTC ISO-8601> # optional OKF field
claims:
  - id: claim-001
    text: <claim statement>
    anchors:
      - <source anchor id>
---
```

Topic maps require `type: Topic Map`, `title`, `description`, and `contract_version`. They MUST NOT include `source` or `claims` blocks.

### Claim identifiers

- Format: `claim-NNN` where `NNN` is a zero-padded three-digit decimal (`claim-001`, `claim-002`, …).
- Every material claim in `# Key Claims` MUST reference a claim ID present in frontmatter.
- Duplicate and contradiction proposals MUST cite at least one claim ID.

### Source anchors

- Anchor IDs are stable within the source envelope (e.g. `anchor-001`, `slide-003`, `timestamp-01:23:45`).
- Every claim MUST list at least one source anchor.
- Anchors MUST resolve to entries in the normalized source envelope used for conversion.

## Required Markdown sections

### All source-derived notes

1. `# Summary` — concise overview.
2. `# Key Claims` — bullet list; each bullet references `claim-NNN`.
3. `# Citations` — bibliographic or source pointers.
4. `# Evidence` — quoted or paraphrased support tied to source anchors.

### Slide Deck Note additional sections

5. `# Narrative` — reconstructed story across slides (not slide-by-slide transcription).
6. `# Slide Coverage` — table or list mapping each slide number to coverage status (`covered`, `partial`, `excluded`) with rationale for exclusions.

Deck notes MUST NOT commit with incomplete slide coverage or missing narrative.

## Deck fidelity rules

- Ordered slide coverage MUST match the source envelope slide list.
- Speaker notes MUST be reflected when present in the envelope.
- Numbers, units, and named entities MUST NOT be altered without explicit curator comment.
- No unsupported claims: every claim MUST trace to a source anchor.

## Fail-closed behavior

- Unknown frontmatter keys at the note-contract level fail validation.
- Missing `contract_version`, empty `source_key`, or malformed `content_sha256` fail validation.
- Credential fields (`token`, `api_key`, `password`, `secret`, `credential`) are prohibited anywhere in managed notes.

## Versioning

- `contract_version` MUST match a published `okf-note-contract/*` release.
- Validators fail closed on unknown contract versions.
- OKF v0.1 reserved files (`index.md`, `log.md`) follow OKF semantics; this contract layers additional requirements on concept notes only.
