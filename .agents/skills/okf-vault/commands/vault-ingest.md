---
disable-model-invocation: true
---

# /vault-ingest

Guided ingest wizard for one explicit source (MCP artifact or local file).

## Where to go

- **Wizard contract** — [`references/ingest-wizard.md`](../references/ingest-wizard.md) (step order, branches, session handoff)
- **Skill ingest mode** — [`SKILL.md`](../SKILL.md#ingest) (orchestration after `delegate_ingest`)
- **Command registry** — [`registry.md`](registry.md) (full `/vault-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
