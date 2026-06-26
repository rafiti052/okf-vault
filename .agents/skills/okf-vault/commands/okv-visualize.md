---
name: okv-visualize
disable-model-invocation: true
---

# /okv-visualize

Invoke the configured OKF visualizer for manual graph review.

## Where to go

- **Skill visualize mode** — [`SKILL.md`](../SKILL.md#visualize) (visualizer orchestration)
- **Helper CLI** — agents invoke `okv visualize --json` with argument arrays when helper output is needed
- **Command registry** — [`registry.md`](registry.md) (full `/okv-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
