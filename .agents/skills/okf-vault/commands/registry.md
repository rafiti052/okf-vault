# OKV Command Registry

Provider-neutral `/okv-*` command list for curator discoverability. Each command is a pointer-only stub under `commands/`; orchestration stays in [`SKILL.md`](../SKILL.md), pipeline handoffs stay in [`pipelines.md`](../references/pipelines.md), and acquisition UX for ingest stays in [`ingest-wizard.md`](../references/ingest-wizard.md). Map runtime capabilities at preflight per [`capabilities.md`](../references/capabilities.md) — do not embed MCP tool names here.

Agents invoking the deterministic helper use `okv <verb> --json` with argument arrays. Slash commands select the workflow mode; helper verbs provide the machine-readable gate.

## Commands

| Slash command                              | CLI verb(s)                                 | Skill mode / pipeline                                                                                                                                   | Purpose                                                                   | Availability         |
| ------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------- |
| [`/okv-ingest`](okv-ingest.md)             | `okv ingest --json`                         | `ingest` — [`SKILL.md`](../SKILL.md#ingest) — [`ingest-wizard.md`](../references/ingest-wizard.md)                                                      | Guided ingest wizard for one explicit source (MCP artifact or local file) | **MVP shipped**      |
| [`/okv-init`](okv-init.md)                 | `okv init --json`                           | `initialize` — [`SKILL.md`](../SKILL.md#initialize)                                                                                                     | Create vault layout, manifest, indexes, and Git repo at `./knowledge/`    | **Phase 1b shipped** |
| [`/okv-organize`](okv-organize.md)         | `okv dossier --json`                        | `organize` — [`SKILL.md`](../SKILL.md#organize)                                                                                                         | Generate dossiers and curation proposals after ingestion                  | **Phase 1b shipped** |
| [`/okv-validate`](okv-validate.md)         | `okv validate --json`                       | `validate` — [`SKILL.md`](../SKILL.md#validate)                                                                                                         | Run contract, manifest, graph, and recovery checks                        | **Phase 1b shipped** |
| [`/okv-visualize`](okv-visualize.md)       | `okv visualize --json`                      | `visualize` — [`SKILL.md`](../SKILL.md#visualize)                                                                                                       | Invoke the configured OKF visualizer for manual graph review              | **Phase 1b shipped** |
| [`/okv-bootstrap`](okv-bootstrap.md)       | `okv init --json` → `okv validate --json`   | `initialize` → `validate` — [`pipelines.md`](../references/pipelines.md#bootstrap)                                                                      | Initialize a new vault at `./knowledge/` then validate health             | **Phase 1b shipped** |
| [`/okv-ingest-check`](okv-ingest-check.md) | `okv ingest --json` → `okv validate --json` | `ingest` → `validate` — [`pipelines.md`](../references/pipelines.md#ingest-check); acquisition via [`ingest-wizard.md`](../references/ingest-wizard.md) | Ingest explicit sources then validate vault health in one session         | **Phase 1b shipped** |

## When to use

- **New content** — Start with **`/okv-ingest`**. The wizard resolves `./knowledge/` automatically and guides source acquisition.
- **Empty repository** — Run **`/okv-init`** to create `./knowledge/`, or **`/okv-bootstrap`** for init plus validate.
- **After ingestion** — **`/okv-organize`** for curation proposals; **`/okv-validate`** for health checks; **`/okv-visualize`** for graph inspection.
- **Batch ingest with health check** — **`/okv-ingest-check`** composes ingest wizard acquisition with validate.

MVP stub: [`okv-ingest.md`](okv-ingest.md) (**MVP shipped**). Phase 1b mode stubs: [`okv-init.md`](okv-init.md), [`okv-organize.md`](okv-organize.md), [`okv-validate.md`](okv-validate.md), [`okv-visualize.md`](okv-visualize.md) (**Phase 1b shipped**). Pipeline stubs: [`okv-bootstrap.md`](okv-bootstrap.md), [`okv-ingest-check.md`](okv-ingest-check.md) (**Phase 1b shipped**).
