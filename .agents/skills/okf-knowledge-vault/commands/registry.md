# OKF Vault Command Registry

Provider-neutral `/vault-*` command list for curator discoverability. Each command is a pointer-only stub under `commands/`; orchestration stays in [`SKILL.md`](../SKILL.md) and acquisition UX for ingest stays in [`ingest-wizard.md`](../references/ingest-wizard.md). Map runtime capabilities at preflight per [`capabilities.md`](../references/capabilities.md) — do not embed MCP tool names here.

## Commands

| Command               | Purpose                                                                   | Skill mode / pipeline                                                                                                                                   | Availability         |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `/vault-ingest`       | Guided ingest wizard for one explicit source (MCP artifact or local file) | `ingest` — [`ingest-wizard.md`](../references/ingest-wizard.md)                                                                                         | **MVP shipped**      |
| `/vault-init`         | Create vault layout, manifest, indexes, and Git repo at `./knowledge/`    | `initialize` — [`SKILL.md`](../SKILL.md#initialize) — [`vault-init.md`](vault-init.md)                                                                  | **Phase 1b shipped** |
| `/vault-organize`     | Generate dossiers and curation proposals after ingestion                  | `organize` — [`SKILL.md`](../SKILL.md#organize) — [`vault-organize.md`](vault-organize.md)                                                              | **Phase 1b shipped** |
| `/vault-validate`     | Run contract, manifest, graph, and recovery checks                        | `validate` — [`SKILL.md`](../SKILL.md#validate) — [`vault-validate.md`](vault-validate.md)                                                              | **Phase 1b shipped** |
| `/vault-visualize`    | Invoke the configured OKF visualizer for manual graph review              | `visualize` — [`SKILL.md`](../SKILL.md#visualize) — [`vault-visualize.md`](vault-visualize.md)                                                          | **Phase 1b shipped** |
| `/vault-bootstrap`    | Initialize a new vault at `./knowledge/` then validate health             | `initialize` → `validate` — [`pipelines.md`](../references/pipelines.md) bootstrap                                                                      | Phase 1b planned     |
| `/vault-ingest-check` | Ingest explicit sources then validate vault health in one session         | `ingest` → `validate` — [`pipelines.md`](../references/pipelines.md) ingest-check; acquisition via [`ingest-wizard.md`](../references/ingest-wizard.md) | Phase 1b planned     |

## When to use

- **New content** — Start with **`/vault-ingest`** (north star). The wizard resolves `./knowledge/` automatically and guides source acquisition.
- **Empty repository** — Run **`/vault-init`** to create `./knowledge/`, or **`/vault-bootstrap`** for init plus validate (Phase 1b).
- **After ingestion** — **`/vault-organize`** for curation proposals; **`/vault-validate`** for health checks; **`/vault-visualize`** for graph inspection (Phase 1b).
- **Batch ingest with health check** — **`/vault-ingest-check`** composes ingest wizard acquisition with validate (Phase 1b).

MVP stub: [`vault-ingest.md`](vault-ingest.md) (**MVP shipped**). Phase 1b mode stubs: [`vault-init.md`](vault-init.md), [`vault-organize.md`](vault-organize.md), [`vault-validate.md`](vault-validate.md), [`vault-visualize.md`](vault-visualize.md) (**Phase 1b shipped**). Pipeline stubs ship in Phase 1b per ADR-008.
