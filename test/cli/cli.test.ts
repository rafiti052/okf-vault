import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ExitCode,
  RESERVED_COMMANDS,
  dispatch,
  helpText,
  parseArgs,
  run,
} from "../../dist/cli/cli.js";
import { loadManifest, manifestRevision } from "../../dist/vault/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  private: boolean;
  engines: { node: string };
  packageManager: string;
  bin: Record<string, string>;
};

function captureRun(argv: string[], options: { stdoutIsTTY?: boolean } = {}) {
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
  }
}

describe("package metadata", () => {
  it("declares Node >= 24, exact pnpm version, private package, and dual bins", () => {
    assert.equal(packageJson.engines.node, ">=24");
    assert.equal(packageJson.packageManager, "pnpm@11.8.0");
    assert.equal(packageJson.private, true);
    assert.deepEqual(Object.keys(packageJson.bin).sort(), ["okf-vault", "okv"].sort());
  });
});

describe("CLI parsing and dispatch", () => {
  it("returns help and version without invoking domain handlers", () => {
    const help = dispatch(parseArgs(["--help"]));
    assert.equal(help.exitCode, ExitCode.SUCCESS);
    assert.equal(help.result?.status, "ok");
    assert.equal(help.result?.command, "help");

    const version = dispatch(parseArgs(["--version"]));
    assert.equal(version.exitCode, ExitCode.SUCCESS);
    assert.equal(version.result?.status, "ok");
    assert.equal(version.result?.command, "version");
  });

  it("accepts reserved commands and rejects unknown commands with usage exit", () => {
    const implementedWithoutArgs = new Set([
      "init",
      "inspect",
      "validate-staged",
      "validate-graph",
      "validate",
      "visualize",
      "commit",
      "recover",
      "dossier",
      "validate-proposals",
    ]);
    for (const command of RESERVED_COMMANDS) {
      if (command === "init" || command === "uninstall") {
        continue;
      }
      const outcome = dispatch(parseArgs([command]));
      if (implementedWithoutArgs.has(command)) {
        assert.equal(outcome.exitCode, ExitCode.USAGE);
      } else {
        assert.equal(outcome.exitCode, ExitCode.VALIDATION);
        assert.equal(outcome.result?.status, "error");
        assert.equal(outcome.result?.command, command);
      }
    }

    const unknown = dispatch(parseArgs(["not-a-command"]));
    assert.equal(unknown.exitCode, ExitCode.USAGE);
    assert.equal(unknown.result?.status, "error");
    assert.equal(unknown.result?.code, "USAGE_UNKNOWN_COMMAND");
  });

  it("maps usage, validation, and success outcomes to exit statuses 2, 3, and 0", () => {
    assert.equal(captureRun([]).exitCode, ExitCode.USAGE);
    assert.equal(captureRun(["commit"]).exitCode, ExitCode.USAGE);
    assert.equal(captureRun(["recover"]).exitCode, ExitCode.USAGE);
    assert.equal(captureRun(["--version"]).exitCode, ExitCode.SUCCESS);
  });

  it("serializes JSON envelopes without diagnostic contamination on stdout", () => {
    const result = captureRun(["--version", "--json"]);

    assert.equal(result.exitCode, ExitCode.SUCCESS);
    const payload = JSON.parse(result.stdout.trim()) as { status: string };
    assert.equal(payload.status, "ok");
    assert.doesNotMatch(result.stdout, /Missing command/);
  });

  it("preserves JSON help when --json is explicit", () => {
    const result = captureRun(["--help", "--json"], { stdoutIsTTY: true });

    assert.equal(result.exitCode, ExitCode.SUCCESS);
    const payload = JSON.parse(result.stdout) as { status: string; command: string };
    assert.equal(payload.status, "ok");
    assert.equal(payload.command, "help");
  });

  it("renders human help as non-JSON text when --human is explicit", () => {
    const result = captureRun(["--help", "--human"], { stdoutIsTTY: false });

    assert.equal(result.exitCode, ExitCode.SUCCESS);
    assert.match(result.stdout, /Usage/);
    assert.throws(() => JSON.parse(result.stdout));
  });

  it("emits a single JSON line for validate failures in explicit JSON mode", () => {
    const missingVault = join(root, "test", "fixtures", "vaults", "resolve", "missing-vault");
    const result = captureRun(["validate", missingVault, "--json"], { stdoutIsTTY: true });

    assert.equal(result.exitCode, ExitCode.UNEXPECTED);
    assert.match(result.stdout, /^\{"status":"error"/);
    assert.equal(result.stdout.endsWith("\n"), true);
    assert.equal(result.stdout.split("\n").length, 2);
    assert.doesNotThrow(() => JSON.parse(result.stdout));
  });

  it("keeps --version JSON bytes identical when --json overrides TTY detection", () => {
    const ttyJson = captureRun(["--version", "--json"], { stdoutIsTTY: true });
    const pipedJson = captureRun(["--version", "--json"], { stdoutIsTTY: false });

    assert.equal(ttyJson.exitCode, ExitCode.SUCCESS);
    assert.equal(pipedJson.exitCode, ExitCode.SUCCESS);
    assert.equal(ttyJson.stdout, pipedJson.stdout);
    assert.equal(
      ttyJson.stdout,
      `${JSON.stringify({ status: "ok", command: "version", data: { version: "okv/0.1.0" } })}\n`,
    );
  });

  it("keeps diagnostics on stderr when human mode is selected", () => {
    const result = captureRun(["missing", "--human"], { stdoutIsTTY: false });

    assert.equal(result.exitCode, ExitCode.USAGE);
    assert.match(result.stdout, /Unknown command: missing/);
    assert.match(result.stderr, /Unknown command: missing/);
    assert.doesNotMatch(result.stderr, /^\{/);
  });

  it("includes reserved commands and init usage in help text", () => {
    const text = helpText();
    for (const command of RESERVED_COMMANDS) {
      assert.match(text, new RegExp(command));
    }
    assert.match(text, /init \[vault-root\]/);
  });
});

describe("exit class mapping helpers", () => {
  it("documents conflict and transaction exit classes", () => {
    assert.equal(ExitCode.CONFLICT, 4);
    assert.equal(ExitCode.TRANSACTION, 5);
    assert.equal(ExitCode.UNEXPECTED, 1);
  });
});

describe("compiled executable integration", () => {
  it("returns help/version and structured unknown-command output", () => {
    const bin = join(root, "dist", "main.js");
    const help = spawnSync(process.execPath, [bin, "--help", "--json"], { encoding: "utf8" });
    assert.equal(help.status, ExitCode.SUCCESS);
    assert.match(help.stdout, /"status":"ok"/);

    const version = spawnSync(process.execPath, [bin, "--version", "--json"], { encoding: "utf8" });
    assert.equal(version.status, ExitCode.SUCCESS);
    assert.match(version.stdout, /"version":"okv\/0.1.0"/);

    const unknown = spawnSync(process.execPath, [bin, "missing", "--json"], { encoding: "utf8" });
    assert.equal(unknown.status, ExitCode.USAGE);
    assert.match(unknown.stdout, /USAGE_UNKNOWN_COMMAND/);
    assert.match(unknown.stderr, /Unknown command/);
  });

  it("defaults to JSON when stdout is piped", () => {
    const bin = join(root, "dist", "main.js");
    const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });

    assert.equal(version.status, ExitCode.SUCCESS);
    assert.deepEqual(JSON.parse(version.stdout) as unknown, {
      status: "ok",
      command: "version",
      data: { version: "okv/0.1.0" },
    });
  });

  it("preserves explicit JSON inspect bytes for agent callers", () => {
    const bin = join(root, "dist", "main.js");
    const vaultRoot = join(root, "test", "fixtures", "vaults", "navigation", "pass");
    const origin = "/tmp/sources/sample-article.md";
    const revision = manifestRevision(loadManifest(vaultRoot));
    const inspect = spawnSync(
      process.execPath,
      [bin, "inspect", "--json", vaultRoot, "local", origin, "a".repeat(64)],
      { encoding: "utf8" },
    );

    assert.equal(inspect.status, ExitCode.SUCCESS);
    assert.equal(
      inspect.stdout,
      `${JSON.stringify({
        status: "ok",
        command: "inspect",
        data: {
          source_key: `local:${origin}`,
          outcome: "new",
          revision,
        },
      })}\n`,
    );
  });
});
