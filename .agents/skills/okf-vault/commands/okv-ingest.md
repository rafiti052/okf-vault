---
name: okv-ingest
disable-model-invocation: true
---

# /okv-ingest

OKV guided ingest wizard for one explicit source (MCP artifact or local file).

## Where to go

- **Wizard contract** — [`references/ingest-wizard.md`](../references/ingest-wizard.md) (step order, branches, session handoff)
- **Skill ingest mode** — [`SKILL.md`](../SKILL.md#ingest) (orchestration after `delegate_ingest`)
- **Helper CLI** — agents invoke `okv ingest --json` with argument arrays when helper output is needed
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
