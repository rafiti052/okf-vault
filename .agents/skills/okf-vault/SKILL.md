---
name: okf-vault
description: >-
  Provider-neutral OKF Knowledge Vault workflow. Commands: /okv-ingest (ingest
  wizard, recommended for new content), /okv-init (initialize ./knowledge/),
  /okv-organize, /okv-validate, /okv-visualize, /okv-bootstrap,
  /okv-ingest-check. Triggers: initializing a vault, ingesting
  local/Drive/Granola sources, organizing notes, validating quality,
  visualizing the knowledge graph, bootstrapping a new vault, ingest-then-validate
  pipeline. Orchestrates acquisition and conversion; delegates deterministic
  validation, manifest, graph, and Git work to the okv helper.
---

# OKF Knowledge Vault

Execute the OKV product as a **provider-neutral** workflow. Acquisition, semantic conversion, and curation proposals stay in the agent runtime. Validation, manifest mutation, graph analysis, dossiers, and Git transactions stay in the compiled **okv** helper.

Never embed runtime-specific MCP tool names in durable instructions. Map **capabilities** to installed tools during preflight (see [capabilities.md](references/capabilities.md)).

## User-facing modes

| Mode         | Purpose                                                              | Entry                                                              |
| ------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `initialize` | Create vault layout, manifest, indexes, log, and Git repository      | Curator requests vault setup at a path                             |
| `ingest`     | Sequentially acquire, convert, validate, and commit supplied sources | `/okv-ingest` wizard (recommended) or curator-supplied `sources[]` |
| `organize`   | Generate bounded dossiers and curation proposals after conversion    | Curator requests organization after ingestion                      |
| `validate`   | Run contract, manifest, graph, and recovery checks                   | Curator requests validation on an existing vault                   |
| `visualize`  | Invoke the configured OKF visualizer for manual graph review         | Curator requests visual inspection                                 |

Each mode follows the phase order below unless the mode table limits scope (for example, `initialize` stops after vault creation; `validate` skips acquisition).

## Phase order

1. **Preflight** — Verify vault, Git, helper build, required capabilities, and curator-supplied source metadata. See [capabilities.md](references/capabilities.md).
2. **Acquire & normalize** — Fetch one explicit source and produce a task-01 source envelope. See [normalization.md](references/normalization.md).
3. **Inspect manifest** — Call helper `okv inspect --json` with source key and content hash; handle `new`, `already_processed`, or `changed_conflict`.
4. **Convert** — Apply the relevant conversion profile ([article](references/conversion-profiles/article.md), [deck](references/conversion-profiles/deck.md), [panel](references/conversion-profiles/panel.md), [video](references/conversion-profiles/video.md)) to staged note output under `.okf-vault/tmp/<run-id>/`.
5. **Validate staged** — Call helper `okv validate-staged --json`; stop on failure per ADR-009.
6. **Commit** — Call helper `okv commit --json` for atomic per-source installation. See [helper-invocation.md](references/helper-invocation.md).
7. **Repeat** — Process the next curator-supplied source sequentially (ingest mode only).
8. **Organize / validate / visualize** — Mode-specific downstream phases (tasks 11–13).

Emit structured progress events at every phase boundary. See [progress-events.md](references/progress-events.md).

## Curator interaction rules

- **Explicit sources only** — Never watch Drive, Granola, or filesystem paths automatically.
- **One source at a time** — Complete acquire → validate → commit (or failure handling) before starting the next source.
- **Visible progress** — Emit progress events the curator can read during interactive runs.
- **Failure stop (ADR-009)** — After a source failure, stop the run and offer **retry**, **skip with recorded reason**, or **abort**. Do not silently continue.
- **No shell interpolation** — Invoke the helper with argument arrays only; never interpolate curator paths into shell strings.
- **Deterministic gate** — Do not commit notes that failed helper validation or normalization pre-checks.

## Contract references

| Contract                 | Location                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------- |
| Note contract            | [references/note-contract.md](references/note-contract.md)                             |
| Source envelope          | [references/source-envelope.md](references/source-envelope.md)                         |
| Vault layout             | [references/vault-layout.md](references/vault-layout.md)                               |
| Capabilities & preflight | [references/capabilities.md](references/capabilities.md)                               |
| Normalization            | [references/normalization.md](references/normalization.md)                             |
| Progress events          | [references/progress-events.md](references/progress-events.md)                         |
| Helper invocation        | [references/helper-invocation.md](references/helper-invocation.md)                     |
| Ingest wizard            | [references/ingest-wizard.md](references/ingest-wizard.md)                             |
| Command registry         | [commands/registry.md](commands/registry.md)                                           |
| Sequential ingestion     | [references/ingestion-loop.md](references/ingestion-loop.md)                           |
| Organize / curate        | [references/organize.md](references/organize.md)                                       |
| Visualizer               | [references/visualizer.md](references/visualizer.md)                                   |
| Article conversion       | [references/conversion-profiles/article.md](references/conversion-profiles/article.md) |
| Deck conversion          | [references/conversion-profiles/deck.md](references/conversion-profiles/deck.md)       |
| Panel conversion         | [references/conversion-profiles/panel.md](references/conversion-profiles/panel.md)     |
| Video conversion         | [references/conversion-profiles/video.md](references/conversion-profiles/video.md)     |

**Ingest mode** details live in [ingestion-loop.md](references/ingestion-loop.md). **Organize mode** details live in [organize.md](references/organize.md).

## Mode entry points

### initialize

1. Confirm target vault path with the curator.
2. Run preflight for Git availability and helper `init` readiness (vault may not exist yet).
3. Invoke helper `okv init <vault-root> --json`.
4. Emit `run_started`, then `preflight_passed` or `run_failed`, then `run_completed` on success.

### ingest

**Entry paths** — choose one; orchestration below is identical after run input is known:

| Path               | When                                     | Start                                                                                                                                 |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Command-driven** | Curator invokes `/okv-ingest` (ADR-007)  | Follow [ingest-wizard.md](references/ingest-wizard.md) through acquisition, confirmation, session memory, and post-commit suggestions |
| **Direct**         | Curator supplies an explicit `sources[]` | Parse run input in [Direct run input](#direct-run-input) below                                                                        |

Do **not** embed wizard step lists here — the wizard contract owns acquisition UX; this section owns post-handoff orchestration only.

#### Wizard handoff (command-driven only)

When the wizard reaches `delegate_ingest`, ingest mode receives an **`IngestRunInput`** handoff. The wizard stops; do not re-run wizard steps or redefine post-acquisition phases. After ingest completes, return to [ingest-wizard.md](references/ingest-wizard.md) `post_commit` for chat-ephemeral session updates and curator next-action suggestions.

| Field        | Populated by wizard acquisition                                                                           |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `vault_root` | From `resolveVaultRoot()` during wizard `resolve_vault` — `found` required                                |
| `run_id`     | Assigned at wizard source-type selection                                                                  |
| `sources`    | Single-element array: confirmed `kind` (`local`, `google_drive`, or `granola`), `locator`, `content_type` |

When `resolveVaultRoot()` returns `not_initialized`, the wizard routes to `/okv-init` — **do not** delegate to ingest mode. Validate handoff shape with `parseIngestRunInput()` before continuing to orchestration below.

#### Direct run input

When the curator supplies sources without the wizard, provide `vault_root`, `run_id`, and a non-empty ordered `sources` list. Each entry requires `kind`, `locator`, and `content_type`. Reject duplicate stable source keys.

#### Orchestration (both paths)

1. Run full preflight including capability mapping for every kind in the batch — **after** source metadata is confirmed (wizard handoff or direct input), **before** helper acquisition per [capabilities.md](references/capabilities.md).
2. Emit `run_started`, then `preflight_passed` or `run_failed`.
3. For each source in order, follow [ingestion-loop.md](references/ingestion-loop.md):
   - acquire → normalize → **`okv inspect --json`** → profile select → convert → **`okv validate-staged --json`** → **`okv commit --json`** (or failure stop with retry / skip-with-reason / abort).
4. On `already_processed`, emit `source_already_processed` and advance without commit.
5. On `changed_conflict`, stop before conversion; never overwrite the manifest `note_path`.
6. On curator skip, record manifest `skipped` with reason; emit `validation_failed` with `status: skipped` and no `commit_id`.
7. Finish with `run_completed` when the batch is fully handled or `run_failed` on abort.

**Forbidden during ingest:** batch silent conversion, automatic watchers, reprocessing sources not in the run input, shadow wizard orchestration after `delegate_ingest`.

### organize

Follow [organize.md](references/organize.md). Two modes: **initial** (full corpus, ADR-002) and **incremental** (scoped overlap, ADR-004).

1. **Preflight** — Vault initialized; helper `okv dossier --json` / `okv validate-proposals --json` / `okv validate-graph --json` ready; clean managed paths; no unresolved transaction journal (task 06). Initial mode additionally requires **zero pending sources** in the completed ingest batch.
2. **Dossier scope** — Initial: helper `okv dossier --json` full set. Incremental: new committed dossiers + all Topic Maps + overlap-selected existing notes (deterministic normalized-term overlap).
3. **Proposal generation** — Agent emits proposal JSON only (`topic`, `link`, `duplicate`, `contradiction`). **Never** auto-apply to notes, indexes, or topic maps.
4. **Validation gate** — Run helper `okv validate-proposals --json` before curator presentation. Reject path-move and silent duplicate-merge suggestions.
5. **Curator review** — Emit `organize_proposals_ready` after validation passes. Record accept / reject / resolve-with-comment per proposal.
6. **Application** — Apply only accepted proposals via documented manual steps; preserve stable paths under `notes/`. Run `okv validate-graph --json` after link and index updates.

**Forbidden during organize:** auto-application, note path moves, re-ingest of existing notes, full-vault re-cluster on incremental runs.

### validate

1. Preflight vault and helper availability.
2. Run consolidated helper **`okv validate <vault-root> --json`** — aggregates committed-note contract checks, manifest bidirectional consistency, populated indexes, graph navigation, clean transaction state, proposal dispositions, and required gold-note review markers under `.okf-vault/reviews/`.
3. When a transaction journal or lock is present, run **`okv recover --json`** first; re-run `okv validate --json` until transaction state passes.
4. Emit `quality_gate_passed` when `validate` exits 0, or `validation_failed` / `run_failed` otherwise.

### visualize

1. Preflight vault; confirm **`okv validate --json`** exit 0.
2. Configure `.okf-vault/visualizer.json` per [visualizer.md](references/visualizer.md).
3. Invoke **`okv visualize <vault-root> --json`**; treat HTML output as derived and rebuildable.
4. Visualizer failure must not mutate managed vault files.

## Failure handling summary

| Situation                          | Curator options                                      |
| ---------------------------------- | ---------------------------------------------------- |
| Preflight failure                  | Fix prerequisites; restart mode                      |
| Normalization / envelope failure   | Retry acquisition; skip source; abort run            |
| Helper validation failure (exit 3) | Fix conversion; retry from convert step; skip; abort |
| Manifest conflict (exit 4)         | Curator resolves changed source; retry or skip       |
| Transaction failure (exit 5)       | Run `recover`; retry commit; abort                   |

Map every helper exit class to curator actions in [helper-invocation.md](references/helper-invocation.md).
