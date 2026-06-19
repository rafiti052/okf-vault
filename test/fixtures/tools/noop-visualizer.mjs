#!/usr/bin/env node
/** Stub OKF visualizer for contract tests — writes derived output only, never mutates vault. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vaultRoot = process.argv[2];
if (vaultRoot === undefined) {
  process.stderr.write("usage: noop-visualizer <vault-root>\n");
  process.exit(2);
}

const outputDir = join(vaultRoot, ".okf-vault", "tmp", "visualizer-output");
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, "graph.html"), "<html><body>stub graph</body></html>\n", "utf8");
process.stdout.write(`visualizer-stub ok ${outputDir}\n`);
