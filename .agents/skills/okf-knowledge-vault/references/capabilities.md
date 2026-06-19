# Required Runtime Capabilities

**Boundary:** Durable workflow contracts name **capabilities**, not installed MCP tool identifiers. Map each capability to a runtime tool during preflight and record the mapping in the run journal only — never in committed vault content.

## Capability catalog

| Capability                 | Used for                                        | Required output                                                                             |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `read_local_file`          | Local articles, transcripts, and exported files | File bytes or text, normalized path, modification time                                      |
| `fetch_drive_document`     | Google Drive documents and decks                | File ID, export content, MIME type, title, modified time, canonical URI                     |
| `fetch_granola_transcript` | Granola meeting transcripts                     | Meeting ID, transcript text, speaker/timestamp markers when available, title, canonical URI |
| `inspect_deck_slides`      | Slide deck fidelity                             | Ordered slide text, speaker notes, rendered slide images, stable slide numbers              |
| `invoke_process`           | Helper CLI execution                            | Spawn child process with argv array; capture stdout/stderr separately                       |

Deck ingestion requires **`inspect_deck_slides`** in addition to `fetch_drive_document` (or `read_local_file` for on-disk decks).

## Preflight checklist

Run before any acquisition in `ingest` mode (and before helper mutations in other modes). Fail closed when any check fails; emit `run_failed` with a stable error code.

| #   | Check                                                                                                  | Failure code                           |
| --- | ------------------------------------------------------------------------------------------------------ | -------------------------------------- |
| 1   | Vault initialized (`.okf-vault/manifest.json`, indexes, log) or `initialize` mode creating a new vault | `PREFLIGHT_VAULT_NOT_INITIALIZED`      |
| 2   | Git available and vault root is a repository (except during first `init`)                              | `PREFLIGHT_GIT_UNAVAILABLE`            |
| 3   | Compiled helper present (`node dist/main.js` or installed `okf-vault` on PATH)                         | `PREFLIGHT_HELPER_MISSING`             |
| 4   | No unresolved transaction journal requiring recovery                                                   | `PREFLIGHT_TRANSACTION_PENDING`        |
| 5   | Required capabilities mapped for every source kind in the batch                                        | `PREFLIGHT_CAPABILITY_MISSING`         |
| 6   | Curator supplied explicit source metadata: kind, locator, declared content type                        | `PREFLIGHT_SOURCE_METADATA_INCOMPLETE` |
| 7   | Managed Git paths clean (no unexpected edits) before commit phases                                     | `PREFLIGHT_DIRTY_WORKTREE`             |

### Capability mapping by source kind

| Source kind    | Required capabilities                                               |
| -------------- | ------------------------------------------------------------------- |
| `local`        | `read_local_file`; add `inspect_deck_slides` for deck content types |
| `google_drive` | `fetch_drive_document`; add `inspect_deck_slides` for presentations |
| `granola`      | `fetch_granola_transcript`                                          |

### Runtime adapter responsibilities

1. Resolve each capability name to an installed tool the runtime exposes.
2. Verify the tool can return the required output shape (use redacted fixtures offline).
3. Keep authentication and credential storage runtime-owned — envelopes and notes MUST NOT contain credentials.
4. Retry transient read failures at most twice with bounded delay; do not retry auth, validation, or missing-capability failures.

## Preflight pass signal

When all checks succeed, emit **`preflight_passed`** with run ID, phase `preflight`, status `ok`, and duration. See [progress-events.md](progress-events.md).
