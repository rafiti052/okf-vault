---
name: okv-ingest-check
disable-model-invocation: true
---

# /okv-ingest-check

Ingest explicit sources then validate OKV vault health in one guided session.

## Where to go

- **Ingest-check pipeline** — [`references/pipelines.md`](../references/pipelines.md#ingest-check) (mode sequence, curator handoff gates between legs)
- **Ingest acquisition** — [`references/ingest-wizard.md`](../references/ingest-wizard.md) (wizard contract for the ingest leg)
- **Helper CLI** — agents invoke `okv ingest --json` flow helpers and `okv validate --json` with argument arrays when helper output is needed
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
