---
name: okf-knowledge-vault
description: >-
  Provider-neutral OKF Knowledge Vault workflow. Use when initializing a vault,
  ingesting local/Drive/Granola sources, organizing notes, validating quality,
  or visualizing the knowledge graph. Orchestrates acquisition and conversion;
  delegates deterministic validation, manifest, graph, and Git work to the
  okf-vault helper.
---

# OKF Knowledge Vault

Execute the vault product as a **provider-neutral** workflow. Acquisition, semantic conversion, and curation proposals stay in the agent runtime. Validation, manifest mutation, graph analysis, dossiers, and Git transactions stay in the compiled **okf-vault** helper.

Never embed runtime-specific MCP tool names in durable instructions. Map **capabilities** to installed tools during preflight (see [capabilities.md](references/capabilities.md)).

## User-facing modes

| Mode         | Purpose                                                              | Entry                                               |
| ------------ | -------------------------------------------------------------------- | --------------------------------------------------- |
| `initialize` | Create vault layout, manifest, indexes, log, and Git repository      | Curator requests vault setup at a path              |
| `ingest`     | Sequentially acquire, convert, validate, and commit supplied sources | Curator supplies an explicit source list with kinds |
| `organize`   | Generate bounded dossiers and curation proposals after conversion    | Curator requests organization after ingestion       |
| `validate`   | Run contract, manifest, graph, and recovery checks                   | Curator requests validation on an existing vault    |
| `visualize`  | Invoke the configured OKF visualizer for manual graph review         | Curator requests visual inspection                  |

Each mode follows the phase order below unless the mode table limits scope (for example, `initialize` stops after vault creation; `validate` skips acquisition).

## Phase order

1. **Preflight** — Verify vault, Git, helper build, required capabilities, and curator-supplied source metadata. See [capabilities.md](references/capabilities.md).
2. **Acquire & normalize** — Fetch one explicit source and produce a task-01 source envelope. See [normalization.md](references/normalization.md).
3. **Inspect manifest** — Call helper `inspect` with source key and content hash; handle `new`, `already_processed`, or `changed_conflict`.
4. **Convert** — Apply the relevant conversion profile ([article](references/conversion-profiles/article.md), [deck](references/conversion-profiles/deck.md), [panel](references/conversion-profiles/panel.md), [video](references/conversion-profiles/video.md)) to staged note output under `.okf-vault/tmp/<run-id>/`.
5. **Validate staged** — Call helper `validate-staged`; stop on failure per ADR-009.
6. **Commit** — Call helper `commit` for atomic per-source installation. See [helper-invocation.md](references/helper-invocation.md).
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
| Sequential ingestion     | [references/ingestion-loop.md](references/ingestion-loop.md)                           |
| Article conversion       | [references/conversion-profiles/article.md](references/conversion-profiles/article.md) |
| Deck conversion          | [references/conversion-profiles/deck.md](references/conversion-profiles/deck.md)       |
| Panel conversion         | [references/conversion-profiles/panel.md](references/conversion-profiles/panel.md)     |
| Video conversion         | [references/conversion-profiles/video.md](references/conversion-profiles/video.md)     |

Sequential organization workflow (`references/organize.md`) is added in later tasks — reference it when present; do not invent provider-specific steps here. **Ingest mode** details live in [ingestion-loop.md](references/ingestion-loop.md).

## Mode entry points

### initialize

1. Confirm target vault path with the curator.
2. Run preflight for Git availability and helper `init` readiness (vault may not exist yet).
3. Invoke helper `init <vault-root>`.
4. Emit `run_started`, then `preflight_passed` or `run_failed`, then `run_completed` on success.

### ingest

1. Parse curator run input: non-empty ordered `sources` with `kind`, `locator`, and `content_type` per entry. Reject duplicate stable source keys.
2. Run full preflight including capability mapping for every kind in the batch.
3. Emit `run_started`, then `preflight_passed` or `run_failed`.
4. For each source in order, follow [ingestion-loop.md](references/ingestion-loop.md):
   - acquire → normalize → **inspect** → profile select → convert → **validate-staged** → **commit** (or failure stop with retry / skip-with-reason / abort).
5. On `already_processed`, emit `source_already_processed` and advance without commit.
6. On `changed_conflict`, stop before conversion; never overwrite the manifest `note_path`.
7. On curator skip, record manifest `skipped` with reason; emit `validation_failed` with `status: skipped` and no `commit_id`.
8. Finish with `run_completed` when the batch is fully handled or `run_failed` on abort.

**Forbidden during ingest:** batch silent conversion, automatic watchers, reprocessing sources not in the run input.

### organize

1. Preflight vault initialization, helper `dossier` / `validate-proposals` readiness, and clean managed paths.
2. Generate dossiers and proposals (task 11); emit `organize_proposals_ready`.
3. Present proposals for curator disposition before any application.

### validate

1. Preflight vault and helper availability.
2. Run `validate-staged` (when staging exists), `validate-graph`, manifest inspection, and `recover` when journals indicate interrupted transactions.
3. Emit `quality_gate_passed` when all deterministic checks pass, or `validation_failed` / `run_failed` otherwise.

### visualize

1. Preflight vault and configured visualizer command.
2. Invoke the curator-configured OKF visualizer; treat HTML output as derived and rebuildable.

## Failure handling summary

| Situation                          | Curator options                                      |
| ---------------------------------- | ---------------------------------------------------- |
| Preflight failure                  | Fix prerequisites; restart mode                      |
| Normalization / envelope failure   | Retry acquisition; skip source; abort run            |
| Helper validation failure (exit 3) | Fix conversion; retry from convert step; skip; abort |
| Manifest conflict (exit 4)         | Curator resolves changed source; retry or skip       |
| Transaction failure (exit 5)       | Run `recover`; retry commit; abort                   |

Map every helper exit class to curator actions in [helper-invocation.md](references/helper-invocation.md).
