/**
 * Task 16 — Workflow integration tests for `okv retrieve` and `okv retrieve --eval`.
 *
 * Tests run against the compiled CLI at dist/main.js.
 * The eval vault fixture at test/fixtures/vaults/retrieve-eval/ provides
 * a stable multi-topic vault for integration assertions.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const cliPath = join(root, "dist", "main.js");

/** Vault with multiple topic maps, used for retrieve and eval tests. */
const evalVaultRoot = join(root, "test", "fixtures", "vaults", "retrieve-eval");

/**
 * Run `node dist/main.js retrieve ...args` and return the result.
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 */
function runRetrieve(args, options = {}) {
  return spawnSync(process.execPath, [cliPath, "retrieve", ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
    cwd: options.cwd ?? root,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Task 16.1 — Basic query mode
// ---------------------------------------------------------------------------

describe("okv retrieve — query mode", () => {
  it("exits 0 with JSON output including schema_version, confidence, results", () => {
    const result = runRetrieve([evalVaultRoot, "business strategy planning"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    let payload;
    assert.doesNotThrow(() => {
      payload = JSON.parse(result.stdout);
    }, "stdout must be parseable JSON");
    assert.equal(payload.status, "ok");
    assert.equal(payload.command, "retrieve");
    assert.ok("schema_version" in payload.data, "data must have schema_version");
    assert.ok("confidence" in payload.data, "data must have confidence");
    assert.ok("results" in payload.data, "data must have results");
  });

  it("--json flag produces parseable JSON output", () => {
    const result = runRetrieve(["--json", evalVaultRoot, "software architecture"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    let payload;
    assert.doesNotThrow(() => {
      payload = JSON.parse(result.stdout);
    }, "--json output must be parseable JSON");
    assert.equal(payload.status, "ok");
  });

  it("--human flag produces non-JSON human output", () => {
    const result = runRetrieve(["--human", evalVaultRoot, "team leadership management"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // Human output should NOT start with a JSON object.
    assert.doesNotMatch(result.stdout, /^\s*\{/, "--human output must not be raw JSON");
    // Human output should contain a next step line.
    assert.match(result.stdout, /next:/, "--human output must contain a next step line");
  });

  it("exits 2 when no args supplied (usage error)", () => {
    const result = runRetrieve([]);
    assert.equal(result.status, 2, `Expected exit 2 (usage), got ${result.status}`);
  });
});

// ---------------------------------------------------------------------------
// Task 16.2 — Eval mode
// ---------------------------------------------------------------------------

describe("okv retrieve --eval", () => {
  it("exits 0 or 3 and stdout is parseable JSON with correct schema_version", () => {
    const result = runRetrieve(["--eval", evalVaultRoot]);
    assert.ok(
      result.status === 0 || result.status === 3,
      `Expected exit 0 or 3, got ${result.status}. stderr: ${result.stderr}`,
    );
    let payload;
    assert.doesNotThrow(
      () => {
        payload = JSON.parse(result.stdout);
      },
      `--eval stdout must be parseable JSON. got: ${result.stdout.slice(0, 200)}`,
    );
    assert.equal(payload.status, "ok");
    assert.equal(payload.command, "retrieve");
    assert.equal(
      payload.data.schema_version,
      "okv-retrieve-eval/1.0.0",
      `Expected schema_version "okv-retrieve-eval/1.0.0", got "${payload.data.schema_version}"`,
    );
  });

  it("eval report contains query_results array and metrics object", () => {
    const result = runRetrieve(["--eval", evalVaultRoot]);
    assert.ok(result.status === 0 || result.status === 3, `stderr: ${result.stderr}`);
    const payload = JSON.parse(result.stdout);
    const data = payload.data;
    assert.ok(Array.isArray(data.query_results), "data.query_results must be an array");
    assert.ok(data.query_results.length > 0, "query_results must not be empty");
    assert.ok(
      typeof data.metrics === "object" && data.metrics !== null,
      "data.metrics must be an object",
    );
    assert.ok(typeof data.metrics.hit_rate === "number", "data.metrics.hit_rate must be a number");
    assert.ok(
      typeof data.metrics.total_queries === "number",
      "data.metrics.total_queries must be a number",
    );
  });

  it("eval report always has status ok regardless of hit rate", () => {
    const result = runRetrieve(["--eval", evalVaultRoot]);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "ok", "Eval report must always have status 'ok'");
  });

  it("--human flag for eval produces non-JSON output with hit rate", () => {
    const result = runRetrieve(["--human", "--eval", evalVaultRoot]);
    assert.ok(result.status === 0 || result.status === 3, `stderr: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /^\s*\{/, "--human eval output must not be raw JSON");
    assert.match(result.stdout, /hit rate/i, "--human eval output must mention hit rate");
  });
});

// ---------------------------------------------------------------------------
// Task 16.3 — Arg validation
// ---------------------------------------------------------------------------

describe("okv retrieve — arg validation", () => {
  it("exits 2 when retrieve is called with no arguments", () => {
    const result = runRetrieve([]);
    assert.equal(result.status, 2, `Expected exit 2, got ${result.status}`);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "error");
  });

  it("exits 2 when vault root supplied but no query", () => {
    const result = runRetrieve([evalVaultRoot]);
    assert.equal(result.status, 2, `Expected exit 2, got ${result.status}`);
  });
});
