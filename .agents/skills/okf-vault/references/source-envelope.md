# OKF Knowledge Vault — Source Envelope

**Contract version:** `okf-source-envelope/1.0.0`

An ephemeral acquisition result produced before note conversion. Envelopes are NOT committed to the vault; they feed conversion and validation only.

## Common fields

| Field              | Type   | Required | Description                                                      |
| ------------------ | ------ | -------- | ---------------------------------------------------------------- |
| `contract_version` | string | yes      | Must be `okf-source-envelope/1.0.0`                              |
| `source_key`       | string | yes      | Stable identity (see derivation rules)                           |
| `kind`             | enum   | yes      | `local`, `google_drive`, or `granola`                            |
| `content_type`     | string | yes      | MIME or logical type                                             |
| `origin`           | string | yes      | Canonical locator (path, Drive file ID URI, Granola meeting URI) |
| `canonical_uri`    | string | yes      | Normalized URI for display and deduplication                     |
| `title`            | string | yes      | Human title                                                      |
| `modified_at`      | string | yes      | Source modification time (UTC ISO-8601)                          |
| `content_sha256`   | string | yes      | SHA-256 of normalized content bytes (64 lowercase hex)           |
| `normalized_text`  | string | yes      | Plain text used for conversion                                   |
| `anchors`          | array  | yes      | Ordered anchor objects (may be empty only for trivial sources)   |

Credential fields are prohibited.

## Source key derivation

| Kind           | Derivation                                |
| -------------- | ----------------------------------------- |
| `local`        | `local:` + POSIX-normalized absolute path |
| `google_drive` | `drive:` + provider file ID               |
| `granola`      | `granola:` + provider meeting ID          |

Keys MUST be stable across runs for unchanged sources.

## Anchor object

```json
{
  "id": "anchor-001",
  "kind": "text | slide | speaker_note | image | timestamp | speaker",
  "label": "human-readable label",
  "text": "extracted text",
  "slide_number": 1,
  "timestamp": "00:12:34",
  "speaker": "Name"
}
```

- `id` is required and unique within the envelope.
- `kind`-specific fields are required when applicable (`slide_number` for slides, `timestamp` for transcript markers).

## Kind-specific requirements

### `local`

- `origin` is the normalized filesystem path.
- `canonical_uri` uses `file://` scheme.

### `google_drive`

- `origin` includes the Drive file ID.
- `canonical_uri` uses `https://drive.google.com/file/d/<id>/view`.
- Export text or structured content MUST be complete before conversion starts.

### `granola`

- `origin` includes the meeting ID.
- `canonical_uri` uses a stable Granola meeting URI pattern.
- Transcript MUST include speaker and timestamp markers when the provider supplies them.

## Deck envelope extensions

When `content_type` indicates a slide deck, the envelope MUST also include:

| Field           | Required | Description                               |
| --------------- | -------- | ----------------------------------------- |
| `slides`        | yes      | Ordered array of slide objects            |
| `deck_complete` | yes      | `true` only when every slide is extracted |

### Slide object

```json
{
  "number": 1,
  "title": "optional slide title",
  "text": "visible slide text",
  "speaker_notes": "notes or empty string",
  "image_available": true
}
```

**Acquisition invariants for decks:**

1. Slides MUST be ordered by `number` starting at 1 with no gaps.
2. `deck_complete` MUST be `false` if any slide text, speaker notes, or required imagery is unavailable.
3. Conversion MUST NOT start when `deck_complete` is `false`.
4. `anchors` MUST include at least one anchor per slide.

## Transcript envelope extensions

For panel and video transcripts:

- `anchors` MUST include timestamp markers for material segments.
- Speaker attribution MUST be preserved when available.

## Validation

- Unknown envelope versions fail closed.
- Empty `source_key`, malformed SHA-256, or missing required kind-specific fields fail validation.
- Envelopes MUST NOT reference provider MCP tool names — only normalized data.
