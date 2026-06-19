# Structured Progress Events

The workflow emits machine-readable progress events during interactive runs. Events supplement **`log.md`** (human history) and **Git** (authoritative committed state). Failed transactions stay in journals and events — not in the committed manifest (ADR-009).

## Event vocabulary

| Event                      | Phase       | When emitted                                        |
| -------------------------- | ----------- | --------------------------------------------------- |
| `run_started`              | `preflight` | Mode execution begins; run ID assigned              |
| `preflight_passed`         | `preflight` | All preflight checks succeed                        |
| `source_acquired`          | `acquire`   | Normalized envelope passes pre-checks               |
| `source_already_processed` | `inspect`   | Manifest inspect reports unchanged committed source |
| `conversion_started`       | `convert`   | Conversion profile execution begins                 |
| `validation_failed`        | `validate`  | Helper or normalization validation fails            |
| `source_committed`         | `commit`    | Atomic commit succeeds for one source               |
| `organize_proposals_ready` | `organize`  | Dossiers and proposals generated for curator review |
| `quality_gate_passed`      | `validate`  | All deterministic quality checks pass               |
| `run_failed`               | `any`       | Unrecoverable error or curator abort                |
| `run_completed`            | `finalize`  | Mode completes successfully                         |

Tasks 10–13 depend on this vocabulary — do not rename events without updating downstream references.

## Event shape

Every event MUST include:

| Field         | Required | Description                                                   |
| ------------- | -------- | ------------------------------------------------------------- |
| `event`       | yes      | One of the vocabulary names above                             |
| `run_id`      | yes      | Stable identifier for the interactive run                     |
| `phase`       | yes      | Current workflow phase                                        |
| `status`      | yes      | `ok`, `skipped`, or `failed`                                  |
| `timestamp`   | yes      | UTC ISO-8601 emission time                                    |
| `duration_ms` | yes      | Elapsed milliseconds since phase or run start (as applicable) |

Include when applicable:

| Field        | When                                              |
| ------------ | ------------------------------------------------- |
| `source_key` | Source-scoped phases (`acquire` through `commit`) |
| `error_code` | `status: failed` or `validation_failed`           |
| `commit_id`  | After successful `source_committed`               |
| `message`    | Curator-facing short summary                      |

Example (single-source happy path excerpt):

```json
{"event":"run_started","run_id":"run-20260619-001","phase":"preflight","status":"ok","timestamp":"2026-06-19T12:00:00.000Z","duration_ms":0}
{"event":"preflight_passed","run_id":"run-20260619-001","phase":"preflight","status":"ok","timestamp":"2026-06-19T12:00:01.000Z","duration_ms":1000}
{"event":"source_acquired","run_id":"run-20260619-001","phase":"acquire","source_key":"drive:file-abc","status":"ok","timestamp":"2026-06-19T12:00:05.000Z","duration_ms":4000}
{"event":"conversion_started","run_id":"run-20260619-001","phase":"convert","source_key":"drive:file-abc","status":"ok","timestamp":"2026-06-19T12:00:10.000Z","duration_ms":5000}
{"event":"source_committed","run_id":"run-20260619-001","phase":"commit","source_key":"drive:file-abc","status":"ok","commit_id":"abc1234","timestamp":"2026-06-19T12:00:30.000Z","duration_ms":25000}
{"event":"run_completed","run_id":"run-20260619-001","phase":"finalize","status":"ok","timestamp":"2026-06-19T12:00:31.000Z","duration_ms":31000}
```

## Failure-stop behavior

1. Emit `validation_failed` or `run_failed` with `error_code` before stopping.
2. Do not emit `source_committed` for the failed source.
3. Present curator choices: **retry**, **skip** (record reason via manifest `skipped` status in a later successful path), or **abort**.
4. On abort, emit `run_failed` then halt without processing remaining sources.

## Emission points summary

| Workflow step               | Event(s)                          |
| --------------------------- | --------------------------------- |
| Mode start                  | `run_started`                     |
| Preflight success / failure | `preflight_passed` / `run_failed` |
| Envelope ready              | `source_acquired`                 |
| Manifest unchanged hit      | `source_already_processed`        |
| Note rendering begins       | `conversion_started`              |
| Helper validate-staged fail | `validation_failed`               |
| Helper commit success       | `source_committed`                |
| Organization batch ready    | `organize_proposals_ready`        |
| Validate mode all pass      | `quality_gate_passed`             |
| Mode success / fatal error  | `run_completed` / `run_failed`    |
