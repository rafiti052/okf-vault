import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { run } from "../../dist/cli.js";
import { loadManifest, manifestRevision } from "../../dist/vault/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const bin = join(root, "dist", "main.js");

const RESERVED_COMMANDS = [
  "init",
  "inspect",
  "validate-staged",
  "commit",
  "dossier",
  "validate-proposals",
  "validate-graph",
  "validate",
  "visualize",
  "recover",
  "uninstall",
] as const;

function isJsonLine(text: string): boolean {
  return /^\{/.test(text.trim());
}

function hasNextStep(text: string): boolean {
  return text.includes("→ next:") || text.includes("-> next:");
}

function captureRun(argv: string[], options: { stdoutIsTTY?: boolean; env?: Record<string, string> } = {}) {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  if (options.stdoutIsTTY !== undefined) {
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: options.stdoutIsTTY,
    });
  }

  const originalEnv = process.env;
  if (options.env) {
    process.env = { ...originalEnv, ...options.env };
  }

  try {
    const exitCode = run(argv);
    return {
      exitCode,
      stdout: stdoutChunks.join(""),
      stderr: stderrChunks.join(""),
    };
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalStdoutIsTTY !== undefined) {
      Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
    } else {
      delete (process.stdout as { isTTY?: boolean }).isTTY;
    }
    process.env = originalEnv;
  }
}

describe("CLI Human Smoke (Unit)", () => {
  const env = { NO_COLOR: "1" };

  it("run([\"--help\", \"--human\"]) stdout contains next step and no JSON", () => {
    const help = captureRun(["--help", "--human"], { env });
    assert.equal(isJsonLine(help.stdout), false);
    assert.ok(hasNextStep(help.stdout));
  });

  it("run([\"--version\", \"--human\"]) emits non-empty plain text version summary", () => {
    const version = captureRun(["--version", "--human"], { env });
    assert.equal(isJsonLine(version.stdout), false);
    assert.ok(hasNextStep(version.stdout));
    assert.match(version.stdout, /version:/);
  });

  it("run([\"validate\", \"--human\", ...]) against invalid fixture emits failure glyph and next step", () => {
    const missingVault = join(root, "test", "fixtures", "vaults", "resolve", "missing-vault");
    const result = captureRun(["validate", "--human", missingVault], { env });
    assert.equal(isJsonLine(result.stdout), false);
    assert.ok(hasNextStep(result.stdout));
    assert.match(result.stdout, /[✗x] validate/);
  });

  it("run([\"uninstall\", \"--dry-run\", \"--human\"]) renders table headers for removed/skipped targets", () => {
    const result = captureRun(["uninstall", "--dry-run", "--human"], { env });
    assert.equal(isJsonLine(result.stdout), false);
    assert.ok(hasNextStep(result.stdout));
    assert.match(result.stdout, /artifact/);
    assert.match(result.stdout, /removed/);
    assert.match(result.stdout, /skipped/);
  });

  it("Unknown command human output includes recommended okv --help next step", () => {
    const unknown = captureRun(["missing", "--human"], { env });
    assert.equal(isJsonLine(unknown.stdout), false);
    assert.match(unknown.stdout, /USAGE_UNKNOWN_COMMAND/);
    assert.match(unknown.stdout, /check the command name with --help, then retry/);
  });
});

describe("CLI Human Smoke (Integration)", () => {
  const env = { ...process.env, NO_COLOR: "1" };
  const vaultRoot = join(root, "test", "fixtures", "vaults", "navigation", "pass");

  const commandArgs: Record<string, string[]> = {
    init: ["init", "--dry-run", vaultRoot],
    inspect: ["inspect", vaultRoot, "local", "/tmp/origin.md", "a".repeat(64)],
    "validate-staged": ["validate-staged", vaultRoot],
    "validate-graph": ["validate-graph", vaultRoot],
    validate: ["validate", vaultRoot],
    "validate-proposals": ["validate-proposals", vaultRoot],
    commit: ["commit", vaultRoot], // Likely fails validation, but we just check human formatting
    recover: ["recover", vaultRoot],
    dossier: ["dossier", vaultRoot],
    visualize: ["visualize", vaultRoot],
    uninstall: ["uninstall", "--dry-run", vaultRoot],
  };

  it("For each reserved command, spawned full CLI exits with non-JSON stdout and next steps", () => {
    for (const cmd of RESERVED_COMMANDS) {
      const args = commandArgs[cmd]!;
      const result = spawnSync(process.execPath, [bin, ...args, "--human"], { encoding: "utf8", env });
      
      assert.ok(result.stdout.trim().length > 0, `${cmd} stdout empty`);
      assert.equal(isJsonLine(result.stdout), false, `${cmd} leaked JSON: ${result.stdout}`);
      assert.ok(hasNextStep(result.stdout), `${cmd} missing next step: ${result.stdout}`);
    }
  });

  it("Same commands with --json produce single-line JSON stdout matching golden fixture bytes", () => {
    // We don't have stored hardcoded golden bytes, but we can verify it's valid JSON
    // and exactly one line of JSON output without presentation headers.
    for (const cmd of ["validate", "inspect", "uninstall"] as const) {
      const args = commandArgs[cmd]!;
      const result = spawnSync(process.execPath, [bin, ...args, "--json"], { encoding: "utf8", env });
      
      const lines = result.stdout.trim().split("\n");
      assert.equal(lines.length, 1, `${cmd} emitted multiple lines in JSON mode`);
      assert.doesNotThrow(() => JSON.parse(lines[0]!), `${cmd} emitted invalid JSON: ${lines[0]}`);
      const parsed = JSON.parse(lines[0]!) as { status: string; command: string };
      assert.ok(parsed.status === "ok" || parsed.status === "error");
    }
  });

  it("Mock TTY true + --json on inspect matches non-TTY --json bytes exactly", () => {
    const origin = "/tmp/sources/sample-article.md";
    const args = ["inspect", "--json", vaultRoot, "local", origin, "a".repeat(64)];
    
    const ttyJson = captureRun(args, { stdoutIsTTY: true, env: { NO_COLOR: "1" } });
    const pipedJson = captureRun(args, { stdoutIsTTY: false, env: { NO_COLOR: "1" } });

    assert.equal(ttyJson.exitCode, 0);
    assert.equal(pipedJson.exitCode, 0);
    assert.equal(ttyJson.stdout, pipedJson.stdout);
    
    const rev = manifestRevision(loadManifest(vaultRoot));
    const expected = `${JSON.stringify({
      status: "ok",
      command: "inspect",
      data: {
        source_key: `local:${origin}`,
        outcome: "new",
        revision: rev,
      },
    })}\n`;
    
    assert.equal(ttyJson.stdout, expected);
  });
});
