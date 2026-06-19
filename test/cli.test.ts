import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ExitCode, RESERVED_COMMANDS, dispatch, helpText, parseArgs, run } from "../dist/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  private: boolean;
  engines: { node: string };
  packageManager: string;
  bin: Record<string, string>;
};

describe("package metadata", () => {
  it("declares Node 24, exact npm version, private package, and one helper bin", () => {
    assert.equal(packageJson.engines.node, "24.x");
    assert.equal(packageJson.packageManager, "npm@11.4.2");
    assert.equal(packageJson.private, true);
    assert.deepEqual(Object.keys(packageJson.bin), ["okf-vault"]);
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
    const implementedWithoutArgs = new Set(["init", "inspect", "validate-staged"]);
    for (const command of RESERVED_COMMANDS) {
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
    assert.equal(run([]), ExitCode.USAGE);
    assert.equal(run(["init"]), ExitCode.USAGE);
    assert.equal(run(["commit"]), ExitCode.VALIDATION);
    assert.equal(run(["--version"]), ExitCode.SUCCESS);
  });

  it("serializes JSON envelopes without diagnostic contamination on stdout", () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;

    try {
      const code = run(["--version"]);
      assert.equal(code, ExitCode.SUCCESS);
      const payload = JSON.parse(chunks.join("").trim()) as { status: string };
      assert.equal(payload.status, "ok");
      assert.doesNotMatch(chunks.join(""), /Missing command/);
    } finally {
      process.stdout.write = original;
    }
  });

  it("includes reserved commands in help text", () => {
    const text = helpText();
    for (const command of RESERVED_COMMANDS) {
      assert.match(text, new RegExp(command));
    }
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
    const help = spawnSync(process.execPath, [bin, "--help"], { encoding: "utf8" });
    assert.equal(help.status, ExitCode.SUCCESS);
    assert.match(help.stdout, /"status":"ok"/);

    const version = spawnSync(process.execPath, [bin, "--version"], { encoding: "utf8" });
    assert.equal(version.status, ExitCode.SUCCESS);
    assert.match(version.stdout, /"version":"0.1.0"/);

    const unknown = spawnSync(process.execPath, [bin, "missing"], { encoding: "utf8" });
    assert.equal(unknown.status, ExitCode.USAGE);
    assert.match(unknown.stdout, /USAGE_UNKNOWN_COMMAND/);
    assert.match(unknown.stderr, /Unknown command/);
  });
});
