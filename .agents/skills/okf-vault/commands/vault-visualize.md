---
name: vault-visualize
disable-model-invocation: true
---

# /vault-visualize

Invoke the configured OKF visualizer for manual graph review.

## Where to go

- **Skill visualize mode** — [`SKILL.md`](../SKILL.md#visualize) (visualizer orchestration)
- **Command registry** — [`registry.md`](registry.md) (full `/vault-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
