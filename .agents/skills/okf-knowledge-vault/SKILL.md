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
4. **Convert** — Apply the relevant conversion profile (tasks 08–09) to staged note output under `.okf-vault/tmp/<run-id>/`.
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

| Contract                 | Location                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| Note contract            | [references/note-contract.md](references/note-contract.md)         |
| Source envelope          | [references/source-envelope.md](references/source-envelope.md)     |
| Vault layout             | [references/vault-layout.md](references/vault-layout.md)           |
| Capabilities & preflight | [references/capabilities.md](references/capabilities.md)           |
| Normalization            | [references/normalization.md](references/normalization.md)         |
| Progress events          | [references/progress-events.md](references/progress-events.md)     |
| Helper invocation        | [references/helper-invocation.md](references/helper-invocation.md) |

Conversion profiles (`references/conversion-profiles/`), sequential ingestion details (`references/ingestion-loop.md`), and organization workflow (`references/organize.md`) are added in later tasks — reference them when present; do not invent provider-specific steps here.

## Mode entry points

### initialize

1. Confirm target vault path with the curator.
2. Run preflight for Git availability and helper `init` readiness (vault may not exist yet).
3. Invoke helper `init <vault-root>`.
4. Emit `run_started`, then `preflight_passed` or `run_failed`, then `run_completed` on success.

### ingest

1. Collect curator-supplied sources: kind (`local`, `google_drive`, `granola`), locator, and declared content type.
2. Run full preflight including capability mapping for every kind in the batch.
3. For each source: acquire → normalize → inspect → convert → validate-staged → commit (or failure handling).
4. Emit ingestion progress events per source; finish with `run_completed` or `run_failed`.

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
