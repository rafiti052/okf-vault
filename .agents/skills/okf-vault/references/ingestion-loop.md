# Sequential Ingestion Loop

Ingest mode processes **only** curator-supplied sources, **one at a time**, in listed order. Each source completes acquire → inspect → convert → validate → commit (or explicit failure handling) before the next source starts. The workflow emits structured progress events at every boundary (see [progress-events.md](progress-events.md)).

## Forbidden behaviors

- **No batch silent conversion** — never convert multiple sources before curator-visible validation and commit boundaries.
- **No automatic watchers** — never poll Drive, Granola, or filesystem paths.
- **No implicit reprocessing** — only sources in the current run input are considered; unchanged sources hit `source_already_processed` via manifest inspect.

## Curator run input

The curator supplies a run definition:

| Field        | Required | Description                                       |
| ------------ | -------- | ------------------------------------------------- |
| `vault_root` | yes      | Initialized OKF vault path                        |
| `run_id`     | yes      | Stable identifier for progress events and staging |
| `sources`    | yes      | Non-empty ordered list of explicit sources        |

Each source entry:

| Field          | Required | Description                                                    |
| -------------- | -------- | -------------------------------------------------------------- |
| `kind`         | yes      | `local`, `google_drive`, or `granola`                          |
| `locator`      | yes      | Path or provider ID (see [normalization.md](normalization.md)) |
| `content_type` | yes      | MIME or logical type for profile selection                     |

The helper rejects empty source lists and duplicate stable source keys in one run definition.

## Per-source loop

For each source in curator order:

1. **Acquire & normalize** — Map capabilities, fetch content, build a task-01 envelope. Emit `source_acquired` on success.
2. **Manifest inspect** — Call helper `inspect <vault-root> <kind> <origin> <content-sha256>`.
3. **Preflight branch** — See [Manifest inspection outcomes](#manifest-inspection-outcomes).
4. **Profile selection** — Map `content_type` and envelope hints to a conversion profile (see [Profile selection](#profile-selection)).
5. **Convert** — Render staged note under `.okf-vault/tmp/<run-id>/`. Emit `conversion_started`.
6. **Validate staged** — Call helper `validate-staged`. On failure emit `validation_failed` and **stop** for curator decision.
7. **Commit** — Call helper `commit` with current manifest revision. On success emit `source_committed` with `commit_id`.
8. **Advance** — Continue to the next listed source or finish the batch.

## Manifest inspection outcomes

| Inspect outcome     | Progress event             | Next action                                                 |
| ------------------- | -------------------------- | ----------------------------------------------------------- |
| `new`               | `conversion_started`       | Proceed to convert → validate → commit                      |
| `already_processed` | `source_already_processed` | **Skip** conversion and commit; advance to next source      |
| `changed_conflict`  | `run_failed`               | **Stop** before conversion; do not alter existing note path |

Helper inspect exit **4** on `changed_conflict`. The workflow must not overwrite the `note_path` recorded in the manifest.

## Profile selection

Map declared `content_type` and envelope shape to conversion profiles from tasks 08–09:

| Profile   | When selected                                                                | Reference                                    |
| --------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| `article` | Default text/document sources without deck slides                            | [article.md](conversion-profiles/article.md) |
| `deck`    | Presentations, deck MIME types, or envelopes with ordered `slides`           | [deck.md](conversion-profiles/deck.md)       |
| `panel`   | `granola` kind or panel/discussion transcript types with speaker markers     | [panel.md](conversion-profiles/panel.md)     |
| `video`   | Video/recording transcripts with timestamp anchors (non-Granola local/Drive) | [video.md](conversion-profiles/video.md)     |

Deck ingestion additionally requires **`inspect_deck_slides`** capability during preflight ([capabilities.md](capabilities.md)).

## Progress events — happy path order

For one new source through batch completion:

1. `run_started`
2. `preflight_passed`
3. `source_acquired`
4. `conversion_started`
5. `source_committed`
6. `run_completed`

Emit `run_completed` only after every listed source is handled (committed, already-processed skip, or curator-recorded skip) or the curator aborts.

## Failure handling (ADR-009)

On validation or transaction failure for the **current** source:

1. Emit `validation_failed` (exit 3) or `run_failed` (exit 4/5/unexpected).
2. **Stop** — do not silently continue to the next source.
3. Present curator choices:

| Choice               | Behavior                                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Retry**            | Re-run from the failed step after curator fixes input or conversion                                                                                                |
| **Skip with reason** | Record manifest `skipped` entry with non-empty `skip_reason`; emit `validation_failed` with `status: skipped` and **no** `commit_id`; advance if curator continues |
| **Abort**            | Emit `run_failed`; halt batch without processing remaining sources                                                                                                 |

Map helper exit classes to actions in [helper-invocation.md](helper-invocation.md). Run `recover` after exit **5** before retrying commit.

## Skip-with-reason and manifest

When the curator skips a source after failure:

1. Build a `skipped` manifest record with stable `source_key`, `content_sha256`, and non-empty `skip_reason`.
2. Persist via manifest save (helper ingestion API `recordSkippedSource` in tests; workflow documents curator confirmation before write).
3. Emit `validation_failed` with `status: skipped` — **no** `commit_id`.
4. Do not install or overwrite curated notes for that source.

Skipped records appear in `.okf-vault/manifest.json` alongside `committed` records (ADR-006).

## Helper invocation order per source

| Step            | Helper command    | Progress on success         |
| --------------- | ----------------- | --------------------------- |
| Inspect         | `inspect`         | (branch-specific)           |
| Validate staged | `validate-staged` | proceed to commit           |
| Commit          | `commit`          | `source_committed`          |
| Recovery        | `recover`         | (after transaction failure) |

Staging directory: `.okf-vault/tmp/<run-id>/`. Pass manifest revision from the latest successful inspect or commit to the next `commit` call.

## Batch completion

Emit `run_completed` when:

- Every explicit source in the run input has been processed (committed, `source_already_processed`, or curator skip recorded), **or**
- The curator aborts the batch (`run_failed` emitted, remaining sources not processed).

Never emit `run_completed` while a source failure awaits curator retry/skip/abort decision.

## Integration test fixtures

Network-free ingest tests pair gold notes under `test/fixtures/notes/gold/<kind>/` with envelopes under `test/fixtures/envelopes/<kind>/`. See `test/vault/ingestion.test.ts` for article, deck, panel, and video happy paths plus duplicate, conflict, and validation-failure recovery cases.
