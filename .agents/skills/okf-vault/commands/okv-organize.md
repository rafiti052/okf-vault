---
name: okv-organize
disable-model-invocation: true
---

# /okv-organize

Generate OKV dossiers and curation proposals after ingestion.

## Where to go

- **Skill organize mode** — [`SKILL.md`](../SKILL.md#organize) (dossier and proposal orchestration)
- **Helper CLI** — agents invoke `okv dossier --json`, `okv validate-proposals --json`, or related helper verbs with argument arrays when needed by the organize flow
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
