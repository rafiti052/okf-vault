# OKF Visualizer

Visual review invokes an **external, curator-configured** command compatible with Google's [reference OKF visualizer](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf). Generated HTML and graph assets are **derived output** — rebuildable at any time and never required for vault integrity.

## Configuration

Store visualizer settings at:

```text
.okf-vault/visualizer.json
```

Example:

```json
{
  "schema_version": "okf-vault-visualizer-config/1.0.0",
  "command": ["npx", "okf-visualizer"],
  "output_dir": ".okf-vault/tmp/visualizer-output"
}
```

| Field            | Required | Description                                             |
| ---------------- | -------- | ------------------------------------------------------- |
| `schema_version` | yes      | Must be `okf-vault-visualizer-config/1.0.0`             |
| `command`        | yes      | Argument array for the visualizer executable (no shell) |
| `output_dir`     | no       | Documented derived-output location (Git-ignored `tmp/`) |

The helper appends `<vault-root>` as the final argument when spawning the configured command.

## Invocation rules

1. Run only after the quality gate passes (`validate` exit 0).
2. Invoke with explicit argument arrays — never shell-interpolated strings.
3. Visualizer failure MUST NOT mutate managed vault files (notes, manifest, indexes, reviews).
4. Do not store credentials, tokens, or API keys in `visualizer.json` or generated HTML.
5. Treat output under `.okf-vault/tmp/` as ephemeral derived artifacts.

## Helper command

```
okf-vault visualize <vault-root>
```

Exit **0** when the visualizer process succeeds; exit **3** when the visualizer returns non-zero; exit **1** on configuration or integrity errors.

## Workflow step

1. Preflight: vault initialized; `validate` passed; `visualizer.json` present.
2. Invoke `okf-vault visualize <vault-root>`.
3. Open generated HTML in a browser for manual structure review.
4. Re-run after curation changes; derived output is safe to delete and regenerate.
