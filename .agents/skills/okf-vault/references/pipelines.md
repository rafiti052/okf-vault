# Declarative Composed Pipelines

**Boundary:** This file defines **exactly two** fixed composed pipelines per ADR-001 and PRD F4. Pipelines are ordered **mode references** with explicit curator handoff gates — not a general composer and not inline orchestration in command stubs.

| Pipeline         | Command             | Mode sequence             |
| ---------------- | ------------------- | ------------------------- |
| **bootstrap**    | `/okv-bootstrap`    | `initialize` → `validate` |
| **ingest-check** | `/okv-ingest-check` | `ingest` → `validate`     |

**Non-goal:** `ingest → organize` and arbitrary mode chaining are out of scope for V1. Command stubs under `commands/` link here; they **must not** paraphrase phase order from [`SKILL.md`](../SKILL.md) or [`ingest-wizard.md`](ingest-wizard.md).

Each mode leg in a pipeline emits its own **`run_started`** / **`run_completed`** pair. Session memory is chat-ephemeral per [`ingest-wizard.md`](ingest-wizard.md); validate legs use a **fresh `run_id`** while retaining the prior leg's `run_id` in `VaultSessionContext.last_run_id` for curator correlation.

## bootstrap

**Purpose:** Initialize a new vault at `./knowledge/` then run a quality gate on vault health in one guided session.

**Command:** `/okv-bootstrap`

### Vault path resolution (first leg)

Before any mode delegation, confirm vault path resolution at **`./knowledge/`** using `resolveVaultRoot()` (ADR-006):

| Status            | Pipeline action                                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_initialized` | **Stop pipeline**; suggest **`/okv-init`** to create layout, manifest, indexes, and Git at `./knowledge/`. Do not delegate to initialize mode until a subsequent run resolves `found`. |
| `found`           | Confirm resolved `vault_root` to curator; proceed to initialize leg only when curator confirms new-vault setup intent.                                                                 |

When status is `not_initialized`, present initialize routing copy — do **not** auto-start validate.

### Mode legs

| Leg | Skill mode entry | Contract reference                            |
| --- | ---------------- | --------------------------------------------- |
| 1   | `initialize`     | [`SKILL.md`](../SKILL.md) **initialize** mode |
| 2   | `validate`       | [`SKILL.md`](../SKILL.md) **validate** mode   |

**Do not** restate initialize or validate phase order here — follow the linked mode entries for orchestration, progress events, and helper invocation.

### Progress events per leg

| Leg        | `run_started`                                        | `run_completed`                                                       |
| ---------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| initialize | Yes — at initialize mode start                       | Yes — on initialize terminal success                                  |
| validate   | Yes — at validate mode start with **fresh `run_id`** | Yes — on validate terminal outcome (`quality_gate_passed` or failure) |

### Handoff gate (initialize → validate)

After the initialize leg reaches a terminal outcome:

| Initialize outcome   | Pipeline action                                                                                                                         |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`          | **Auto-suggest** validate leg; curator **confirms** or **opts out** before validate starts.                                             |
| `failed` / `aborted` | **Hard pause** — do **not** auto-start validate. Offer retry initialize, session end, or explicit curator confirmation before validate. |

On curator confirmation to proceed:

1. Assign a **fresh `run_id`** for the validate leg.
2. Retain the initialize leg `run_id` in `VaultSessionContext.last_run_id` until overwritten by a later ingest or initialize run.
3. Delegate to [`SKILL.md`](../SKILL.md) **validate** mode — no shadow orchestration.

## ingest-check

**Purpose:** Ingest one or more explicit sources then validate vault health in one guided session.

**Command:** `/okv-ingest-check`

### Ingest leg (acquisition + orchestration)

The ingest leg **reuses** the ingest wizard acquisition contract from [`ingest-wizard.md`](ingest-wizard.md) through `delegate_ingest` and skill ingest orchestration:

| Stage              | Contract reference                                                                     |
| ------------------ | -------------------------------------------------------------------------------------- |
| Vault resolution   | [`ingest-wizard.md`](ingest-wizard.md) `resolve_vault` — `./knowledge/` marker only    |
| Source acquisition | [`ingest-wizard.md`](ingest-wizard.md) steps through `delegate_ingest`                 |
| Post-delegation    | [`SKILL.md`](../SKILL.md) **ingest** mode and [`ingestion-loop.md`](ingestion-loop.md) |

**Do not** duplicate wizard step lists or ingestion-loop phase order in this pipeline section. When `resolveVaultRoot()` returns `not_initialized`, follow wizard initialize routing — **do not** delegate to ingest mode.

For each explicit source in the ingest batch, complete the full ingest leg (wizard acquisition → skill ingest → `post_commit` session update) before considering validate.

### Progress events — ingest leg

| Boundary                                 | Events                                                                             |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Skill ingest mode start (per source run) | `run_started`                                                                      |
| Ingest terminal success                  | `run_completed`                                                                    |
| Ingest skip (choice B)                   | `validation_failed` with `status: skipped`; session `last_exit_status` = `skipped` |
| Ingest abort (choice C)                  | `run_failed`; session `last_exit_status` = `aborted`                               |

Retain the ingest leg `run_id` in `VaultSessionContext.last_run_id` after each ingest run for correlation.

### Validate leg

| Leg | Skill mode entry | Contract reference                          |
| --- | ---------------- | ------------------------------------------- |
| 2   | `validate`       | [`SKILL.md`](../SKILL.md) **validate** mode |

Validate mode emits its own **`run_started`** and **`run_completed`** (or `quality_gate_passed` / `validation_failed` / `run_failed`) with a **fresh `run_id`**. Session memory keeps the ingest `run_id` on `last_run_id` until the next ingest run overwrites it.

### Handoff gate (ingest → validate)

Pipeline behavior depends on ingest batch outcomes (ADR-009 failure-stop):

| Ingest batch outcome                                                                    | Pipeline action                                                                                                 |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| **Full success** — all sources in the batch committed; `last_exit_status` = `completed` | **Auto-suggest** validate leg. Curator **confirms** or **opts out** before validate starts. No silent validate. |
| **Partial success** — any source **skipped** (`last_exit_status` = `skipped`)           | **Hard pause** before validate. Do **not** auto-validate.                                                       |
| **Aborted** — ingest run aborted (`last_exit_status` = `aborted`)                       | **Hard pause** before validate. Do **not** auto-validate.                                                       |
| **Unresolved failure** — ADR-009 stop without recovery                                  | **Hard pause** before validate. Do **not** auto-validate.                                                       |

#### Hard pause behavior (skip or abort)

When any ingest source was skipped or the ingest run aborted:

1. Present retry, another explicit source (`/okv-ingest` or continue ingest-check ingest leg), or session end.
2. Do **not** include validate in numbered suggestions until the curator **explicitly confirms** they want a quality gate on a partial or failed batch.
3. After explicit confirmation only: start validate with a **fresh `run_id`**; retain ingest `run_id` in session for correlation.

#### Full-success validate suggestion

When all sources in the ingest batch committed successfully:

1. Suggest **`/okv-validate`** (or continue the ingest-check validate leg) as the next step.
2. Curator **confirms** to proceed or **opts out** — no automatic validate without confirmation.
3. On confirmation, assign a **fresh `run_id`** for validate and delegate to [`SKILL.md`](../SKILL.md) **validate** mode.

### Progress events — validate leg

| Boundary                  | Events                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| Validate mode start       | `run_started` with fresh `run_id`                                                                |
| Validate terminal outcome | `run_completed`, or `quality_gate_passed` / `validation_failed` / `run_failed` per validate mode |

## Session memory across pipeline legs

Pipelines use the same chat-ephemeral `VaultSessionContext` conventions as [`ingest-wizard.md`](ingest-wizard.md):

- **`last_run_id`** — retains the most recent completed leg's `run_id` for curator correlation when the next leg uses a fresh `run_id`.
- **`last_mode`** — updated when each leg reaches its terminal outcome.
- **`last_exit_status`** — drives handoff gates between legs; partial ingest outcomes block auto-validate.

Validate structural updates with `parseVaultSessionContext()` from `src/vault/session.ts`. **Never** write session fields to managed vault paths.

## Related contracts

| Contract                                          | Role                                                         |
| ------------------------------------------------- | ------------------------------------------------------------ |
| [`SKILL.md`](../SKILL.md)                         | Mode orchestration for initialize, ingest, and validate legs |
| [`ingest-wizard.md`](ingest-wizard.md)            | Ingest-check acquisition and post-commit gating              |
| [`ingestion-loop.md`](ingestion-loop.md)          | Per-source ingest orchestration after wizard handoff         |
| [`progress-events.md`](progress-events.md)        | Event vocabulary per leg                                     |
| [`helper-invocation.md`](helper-invocation.md)    | Helper exit codes and ADR-009 curator actions                |
| [`commands/registry.md`](../commands/registry.md) | Command-to-pipeline mapping                                  |
