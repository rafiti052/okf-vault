---
disable-model-invocation: true
---

# /vault-validate

Run contract, manifest, graph, and recovery checks on an existing vault.

## Where to go

- **Skill validate mode** — [`SKILL.md`](../SKILL.md#validate) (quality gate orchestration)
- **Command registry** — [`registry.md`](registry.md) (full `/vault-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
