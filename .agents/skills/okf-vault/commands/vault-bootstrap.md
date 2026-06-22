---
disable-model-invocation: true
---

# /vault-bootstrap

Initialize a new vault at `./knowledge/` then run a quality gate on vault health.

## Where to go

- **Bootstrap pipeline** — [`references/pipelines.md`](../references/pipelines.md#bootstrap) (mode sequence, curator handoff gates between legs)
- **Command registry** — [`registry.md`](registry.md) (full `/vault-*` list and availability)

Runtime adapters under `.cursor/skills/` and `.claude/skills/` should set `disable-model-invocation: true` on slash-command wrappers when the runtime requires it (ADR-008). Prefer symlinks to this canonical stub; add adapter frontmatter only when the runtime cannot inherit from the symlink target.
