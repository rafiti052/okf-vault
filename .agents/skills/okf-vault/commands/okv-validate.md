---
name: okv-validate
disable-model-invocation: true
---

# /okv-validate

Run OKV contract, manifest, graph, and recovery checks on an existing vault.

## Where to go

- **Skill validate mode** — [`SKILL.md`](../SKILL.md#validate) (quality gate orchestration)
- **Helper CLI** — agents invoke `okv validate --json` with argument arrays when helper output is needed
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
