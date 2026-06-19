---
disable-model-invocation: true
---

# /vault-ingest-check

Ingest explicit sources then validate vault health in one guided session.

## Where to go

- **Ingest-check pipeline** — [`references/pipelines.md`](../references/pipelines.md#ingest-check) (mode sequence, curator handoff gates between legs)
- **Ingest acquisition** — [`references/ingest-wizard.md`](../references/ingest-wizard.md) (wizard contract for the ingest leg)
- **Command registry** — [`registry.md`](registry.md) (full `/vault-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
