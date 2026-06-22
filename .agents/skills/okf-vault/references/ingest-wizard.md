# Ingest Wizard Interaction Contract

**Boundary:** This file is the **authoritative curator-facing UX spec** for `/vault-ingest` (ADR-007). It covers vault resolution through source acquisition, confirmation, and handoff to skill ingest mode. **Orchestration after handoff** — preflight, acquire, inspect, convert, validate, commit — lives in [`SKILL.md`](../SKILL.md) ingest mode and [`ingestion-loop.md`](ingestion-loop.md). The wizard **must not** redefine post-delegation phase order.

Session and wizard state are **chat-ephemeral** (ADR-005). Types are defined in `src/vault/session.ts`; field names below match exported TypeScript identifiers without duplicating type definitions.

## Wizard step order

The wizard executes **one source at a time**. Steps follow the `IngestWizardStep` enum in order, branching only at source type and acquisition:

| #   | Step                 | Purpose                                                      |
| --- | -------------------- | ------------------------------------------------------------ |
| 1   | `resolve_vault`      | Marker-based vault root resolution; no path prompt           |
| 2   | `choose_source_type` | Curator selects MCP artifact or local file explicitly        |
| 3a  | `acquire_mcp`        | Browse/select Google Drive or Granola artifact               |
| 3b  | `acquire_local`      | Curator supplies explicit local file path                    |
| 4   | `confirm_source`     | Review `IngestSourceInput` metadata before handoff           |
| 5   | `delegate_ingest`    | **Hard stop** — transfer to skill ingest mode                |
| 6   | `post_commit`        | Session update and next-action suggestions (after skill run) |

Steps `acquire_mcp` and `acquire_local` are mutually exclusive branches from `choose_source_type`.

## Forbidden behaviors

The ingest wizard and its acquisition branches **must never**:

- **Poll or watch** Google Drive, Granola, or filesystem paths automatically — no automatic watchers.
- **Enumerate directories** to discover sources — local paths are curator-supplied only.
- **Infer source type** from context, filename, or MIME sniffing without explicit curator choice.
- **Perform batch silent conversion** — conversion and commit boundaries belong to skill ingest mode after delegation.
- **Bypass helper validation gates** — the wizard stops at `delegate_ingest`; deterministic gates remain in the helper CLI.

## 1. resolve_vault

Before any acquisition prompt, call `resolveVaultRoot(repoRoot)` (ADR-006). The wizard **does not** ask the curator for a vault path.

### Resolution outcomes

| Status            | Condition                                                                                                                    | Wizard action                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `found`           | `knowledge/.okf-vault/manifest.json` exists, or legacy repo-root marker present (knowledge layout preferred when both exist) | Confirm resolved `vault_root` to curator; initialize or refresh `VaultSessionContext.vault_root` |
| `not_initialized` | No marker found                                                                                                              | **Stop wizard acquisition**; present initialize routing copy below                               |

### Initialize routing copy

When status is `not_initialized`, tell the curator:

> No OKF vault is initialized at `./knowledge/` in this repository. Run **`/vault-init`** to create the vault layout, manifest, indexes, and Git repository. You may also use **`/vault-bootstrap`** for a combined new-vault plus first-ingest flow (Phase 1b).

Do not proceed to source type selection until a subsequent `/vault-ingest` resolves `found`.

### Session read

If `VaultSessionContext` already holds a `vault_root` matching the resolved path, skip redundant confirmation copy but still verify the marker on each run.

## 2. choose_source_type

Present **exactly two** explicit choices — no inference, no third option:

| Choice           | `source_type` value | Next step       |
| ---------------- | ------------------- | --------------- |
| **MCP artifact** | `mcp_artifact`      | `acquire_mcp`   |
| **Local file**   | `local_file`        | `acquire_local` |

Record the curator selection in `IngestWizardState.source_type`. Assign a stable `run_id` for progress events before leaving this step.

## 3a. acquire_mcp

Require the curator to **browse and select** one artifact from supported MCP providers. Supported source kinds are **`google_drive`** and **`granola` only** — no other MCP kinds in V1.

### Capability requirements

Map runtime tools at preflight per [`capabilities.md`](capabilities.md):

| Source kind    | Required capabilities                                               |
| -------------- | ------------------------------------------------------------------- |
| `google_drive` | `fetch_drive_document`; add `inspect_deck_slides` for presentations |
| `granola`      | `fetch_granola_transcript`                                          |

Do not embed MCP tool names in curator copy — reference capability names only.

### IngestSourceInput mapping

After curator selection, populate `IngestWizardState.pending_source`:

| Field          | Source                                               |
| -------------- | ---------------------------------------------------- |
| `kind`         | `google_drive` or `granola` per curator selection    |
| `locator`      | Provider-stable ID or canonical URI from acquisition |
| `content_type` | Declared MIME or logical type for profile selection  |

Proceed to `confirm_source` when all three fields are non-empty.

## 3b. acquire_local

Require the curator to supply an **explicit file path** — a single file, not a directory.

### Rules

- Use the `read_local_file` capability ([`capabilities.md`](capabilities.md)) to read the file after path confirmation.
- **Do not** scan directories, glob paths, or suggest files from filesystem enumeration.
- **Do not** start watchers or background polling on the supplied path or parent directories.

### IngestSourceInput mapping

| Field          | Value                                                  |
| -------------- | ------------------------------------------------------ |
| `kind`         | `local`                                                |
| `locator`      | Curator-supplied normalized path                       |
| `content_type` | Curator-declared or envelope-derived MIME/logical type |

Proceed to `confirm_source` when all three fields are non-empty.

## 4. confirm_source

Display `pending_source` metadata (`kind`, `locator`, `content_type`) and resolved `vault_root` for curator approval. On confirm, set `IngestWizardState.step` to `delegate_ingest`. On reject, return to the appropriate acquisition step without mutating managed vault paths.

## 5. delegate_ingest

**Hard stop boundary.** The wizard ends here for orchestration purposes.

Build handoff input for skill ingest mode:

| Handoff field | Source                                           |
| ------------- | ------------------------------------------------ |
| `vault_root`  | From `VaultSessionContext` / resolution          |
| `run_id`      | From `IngestWizardState.run_id`                  |
| `sources`     | Single-element array containing `pending_source` |

Transfer control to **[`SKILL.md`](../SKILL.md) ingest mode**. Follow phase order and per-source loop in [`ingestion-loop.md`](ingestion-loop.md) — **do not redefine** acquire → inspect → convert → validate → commit sequencing in this contract.

After delegation, discard `IngestWizardState` wizard-step tracking; retain `VaultSessionContext` for post-run updates.

## 6. post_commit

Runs after skill ingest mode completes (success, skip, failure resolution, or abort). Update session memory and suggest next curator actions per ADR-007.

### Post-commit suggestion order

When the curator may have more sources to ingest, present suggestions in this **priority order**:

1. **`/vault-ingest`** — ingest another explicit source (highest priority when batch work may continue).
2. **`/vault-validate`** — run quality gate on the vault.
3. **Session end** — conclude when no further vault work is planned.

### Session write

Update `VaultSessionContext` after each ingest run terminal outcome. Validate structural shape with `parseVaultSessionContext()` in agent runtimes before persisting to chat state.

| Field              | When written                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `vault_root`       | After first successful `found` resolution (retain on subsequent runs)                                                               |
| `last_run_id`      | After skill ingest run finishes — retains ingest `run_id` for correlation even when a later `/vault-validate` uses a fresh `run_id` |
| `last_mode`        | Set to `ingest` on ingest terminal outcomes                                                                                         |
| `last_exit_status` | `completed`, `failed`, `aborted`, or `skipped` per run outcome                                                                      |
| `last_source_kind` | `local`, `google_drive`, or `granola` from committed or attempted source                                                            |

#### Write triggers by outcome

| Outcome / event  | Session update                                                                        |
| ---------------- | ------------------------------------------------------------------------------------- |
| `run_completed`  | Write all post-run fields; `last_exit_status` = `completed`                           |
| `run_failed`     | Write `last_run_id`, `last_mode`, `last_exit_status` = `failed`, `last_source_kind`   |
| Skip (choice B)  | Write `last_exit_status` = `skipped`; emit `validation_failed` with `status: skipped` |
| Abort (choice C) | Write `last_exit_status` = `aborted`; emit `run_failed` before presenting options     |

Emit the triggering progress event **before** updating session memory so `last_run_id` matches the ingest `run_id` from that run.

### Post-commit suggestion gating (skip and abort)

When the ingest run ends with `skipped`, `aborted`, or unresolved `failed` (ADR-009 stop):

1. Offer **retry**, **another explicit source** (`/vault-ingest`), or **session end**.
2. Do **not** include `/vault-validate` in numbered suggestions until the curator **explicitly confirms** they want a quality gate on a partial or failed batch.
3. After explicit confirmation, offer `/vault-validate` with a **fresh `run_id`** for the validate leg; retain the ingest `run_id` in `VaultSessionContext.last_run_id` for curator correlation.

When `last_exit_status` is `completed`, follow the [post-commit suggestion order](#post-commit-suggestion-order) above without extra gating.

## Session memory conventions

Session memory is **chat-ephemeral only** — agents hold `VaultSessionContext` in conversation state. **Never** write session fields to `./knowledge/`, `.okf-vault/`, or any other managed vault path. No persistent vault profile database in V1.

Validate structural updates with `parseVaultSessionContext()` from `src/vault/session.ts` before accepting session state across wizard steps or repeat `/vault-ingest` invocations.

### VaultSessionContext fields

| Field              | Role                                                               |
| ------------------ | ------------------------------------------------------------------ |
| `vault_root`       | Last resolved vault directory (from marker, not curator free text) |
| `last_run_id`      | Most recent ingest run identifier for correlation                  |
| `last_mode`        | Last completed skill mode                                          |
| `last_exit_status` | Terminal status of last mode run                                   |
| `last_source_kind` | Kind of last attempted or committed source                         |

### IngestWizardState fields

| Field            | Role                                                    |
| ---------------- | ------------------------------------------------------- |
| `step`           | Current wizard step enum value                          |
| `source_type`    | `mcp_artifact`, `local_file`, or null before selection  |
| `pending_source` | Populated `IngestSourceInput` before handoff            |
| `run_id`         | Stable run identifier assigned at source type selection |

### Session read (wizard start / repeat `/vault-ingest`)

At wizard start, read existing `VaultSessionContext` from chat state (validate with `parseVaultSessionContext()` when shape is uncertain):

- Pre-fill resolved `vault_root` from session when it matches current `resolveVaultRoot()` output — skip redundant vault confirmation per ADR-006.
- Display last run context (`last_run_id`, `last_exit_status`, `last_source_kind`) in summary copy when helpful for repeat runs.
- Assign a **new** `run_id` in `IngestWizardState` for each wizard invocation; do not reuse the previous ingest `run_id` for a new wizard run.

### Validate `run_id` handoff

When the curator chooses `/vault-validate` (after successful ingest or after explicit confirmation on skip/abort):

- Start validate mode with a **fresh `run_id`** — do not reuse the ingest wizard `run_id`.
- Retain the ingest `run_id` in `VaultSessionContext.last_run_id` until the next ingest run completes and overwrites it.
- Update `last_mode` and `last_exit_status` only when validate mode reaches its own terminal outcome (task 11 scope); ingest correlation stays on `last_run_id` from the ingest leg.

## ADR-009 failure handling

On validation, conflict, transaction, or unrecoverable errors during **skill ingest mode** (post-delegation), the workflow **stops** for the current source. Map helper exit codes per [`helper-invocation.md`](helper-invocation.md). **Do not silently continue** to the next source or default to any choice.

Present numbered curator options with **no silent default**:

| Choice                  | Curator action                                                                    |
| ----------------------- | --------------------------------------------------------------------------------- |
| **A) Retry**            | Re-run from the failed step after curator fixes input, conversion, or environment |
| **B) Skip with reason** | Record skip with non-empty reason; advance only if curator explicitly continues   |
| **C) Abort**            | Halt the batch; emit `run_failed`; do not process remaining sources               |

After exit **5** (transaction failure), run helper `recover` before retrying commit ([`helper-invocation.md`](helper-invocation.md)).

Wizard acquisition failures (MCP unavailable, missing capability, unreadable local path) follow the same **A / B / C** pattern before reaching `delegate_ingest`.

## Progress event emission points

Emit events from the vocabulary in [`progress-events.md`](progress-events.md). The wizard itself emits no post-delegation events; skill ingest mode owns emission after `delegate_ingest`.

| Wizard / skill boundary                   | Event(s)                            |
| ----------------------------------------- | ----------------------------------- |
| Skill ingest mode start (post-delegation) | `run_started`                       |
| Preflight success / failure               | `preflight_passed` / `run_failed`   |
| Envelope ready after acquire              | `source_acquired`                   |
| Manifest unchanged                        | `source_already_processed`          |
| Note rendering begins                     | `conversion_started`                |
| Helper validate-staged fail               | `validation_failed`                 |
| Helper commit success                     | `source_committed`                  |
| Validation or fatal error (ADR-009 stop)  | `validation_failed` or `run_failed` |
| Batch / run success                       | `run_completed`                     |

On ADR-009 failure, emit `validation_failed` or `run_failed` with `error_code` **before** presenting A/B/C choices.

## Related contracts

| Contract                                       | Role                                              |
| ---------------------------------------------- | ------------------------------------------------- |
| [`capabilities.md`](capabilities.md)           | MCP and local capability names; preflight mapping |
| [`progress-events.md`](progress-events.md)     | Event vocabulary and shape                        |
| [`ingestion-loop.md`](ingestion-loop.md)       | Post-delegation per-source loop                   |
| [`helper-invocation.md`](helper-invocation.md) | Helper exit codes 0–5 and curator actions         |
| [`SKILL.md`](../SKILL.md)                      | Ingest mode orchestration after handoff           |
