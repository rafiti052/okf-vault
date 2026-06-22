# Source Normalization

Normalization transforms runtime acquisition output into a **task-01 source envelope** before conversion begins. Envelopes are ephemeral — they are not committed to the vault.

Authoritative field definitions: [source-envelope.md](source-envelope.md).

## Normalization pipeline

1. **Resolve identity** — Derive stable `source_key` from kind and locator (see source-envelope derivation rules).
2. **Canonicalize origin** — Set `origin` and `canonical_uri` per kind (`file://`, Drive view URI, Granola meeting URI).
3. **Normalize content** — Produce `normalized_text` used for conversion; compute **`content_sha256`** (64 lowercase hex) over normalized content bytes.
4. **Extract anchors** — Build ordered `anchors` with unique IDs; include slide, speaker, timestamp, and text anchors as applicable.
5. **Kind extensions** — Add deck or transcript fields before validation.
6. **Validate envelope** — Run normalization pre-checks below; reject before `conversion_started`.

## Envelope validation rules

| Rule                                                                          | Error code                     |
| ----------------------------------------------------------------------------- | ------------------------------ |
| `contract_version` must be `okf-source-envelope/1.0.0`                        | `ENVELOPE_UNSUPPORTED_VERSION` |
| Non-empty `source_key`, `title`, `origin`, `canonical_uri`, `normalized_text` | `ENVELOPE_MISSING_FIELD`       |
| Valid SHA-256 pattern on `content_sha256`                                     | `ENVELOPE_INVALID_HASH`        |
| UTC ISO-8601 `modified_at`                                                    | `ENVELOPE_INVALID_TIMESTAMP`   |
| No credential-like fields                                                     | `ENVELOPE_CREDENTIAL_FIELD`    |
| No provider MCP tool names in envelope JSON                                   | `ENVELOPE_PROVIDER_LEAK`       |

## Deck completeness pre-check

When `content_type` indicates a slide deck:

1. Require `slides` array and `deck_complete` boolean.
2. Slides MUST be ordered by `number` starting at **1** with **no gaps**.
3. Each slide MUST include `text`, `speaker_notes` (may be empty string), and `image_available`.
4. `deck_complete` MUST be `true` only when every slide is fully extracted.
5. `anchors` MUST include at least one anchor per slide.

| Condition                                               | Error code                  |
| ------------------------------------------------------- | --------------------------- |
| Missing slide number in sequence (e.g., slide 2 absent) | `INCOMPLETE_DECK_SLIDE_GAP` |
| `deck_complete: true` with missing imagery or text      | `INCOMPLETE_DECK_CONTENT`   |
| `deck_complete: false` when conversion is attempted     | `INCOMPLETE_DECK_BLOCKED`   |

Conversion MUST NOT start when deck pre-check fails.

## Transcript normalization (Granola and local)

For panel and video transcript content types:

- Preserve speaker attribution in `anchors` when the provider supplies it.
- Include timestamp markers for material segments.
- Panel classification requires **`kind: speaker`** anchors when the conversion profile expects speaker attribution.

| Condition                                      | Error code                       |
| ---------------------------------------------- | -------------------------------- |
| Profile requires speaker markers; none present | `INCOMPLETE_TRANSCRIPT_SPEAKERS` |

## Per-kind notes

### `local`

- `origin` is the POSIX-normalized absolute filesystem path.
- `canonical_uri` uses the `file://` scheme.

### `google_drive`

- `origin` includes the Drive file ID (`drive:<id>`).
- Export text or structured content MUST be complete before normalization completes.

### `granola`

- `origin` includes the meeting ID (`granola:<id>`).
- Transcript MUST include speaker and timestamp markers when the provider supplies them.

## Handoff to conversion

After normalization pre-check passes:

1. Emit **`source_acquired`** with source key and content hash.
2. Persist envelope JSON under `.okf-vault/tmp/<run-id>/` for helper `validate-staged`.
3. Proceed to manifest `inspect` and conversion profiles.
