import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliError } from "../../dist/cli/cli.js";
import { ExitCode } from "../../dist/cli/cli.js";
import { initializeVault } from "../../dist/vault/manifest.js";
import { isValidVaultRoot, resolveVaultRoot, handleRetrieve } from "../../dist/vault/retrieve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

/** Create a temp directory that is a fully initialized vault root. */
function makeVaultRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "okv-retrieve-test-"));
  initializeVault(dir);
  return dir;
}

/** Create a plain temp directory that is NOT a vault root. */
function makePlainDir(): string {
  return mkdtempSync(join(tmpdir(), "okv-plain-test-"));
}

/** Create a nested subdirectory inside a vault root (not the root itself). */
function makeNestedDir(vaultRoot: string): string {
  const nested = join(vaultRoot, "notes", "subdir");
  mkdirSync(nested, { recursive: true });
  return nested;
}

/** Assert that a CliResult is an error with a given code. */
function assertErrorCode(result: unknown, expectedCode: string): void {
  assert.ok(result != null, "result must not be null");
  const r = result as { status: string; code?: string };
  assert.equal(r.status, "error", `expected status "error", got "${r.status}"`);
  assert.equal((r as CliError).code, expectedCode);
}

// ---------------------------------------------------------------------------
// isValidVaultRoot
// ---------------------------------------------------------------------------

describe("isValidVaultRoot", () => {
  it("returns true for a properly initialized vault directory", () => {
    const vault = makeVaultRoot();
    assert.equal(isValidVaultRoot(vault), true);
  });

  it("returns false for a plain directory with no manifest", () => {
    const plain = makePlainDir();
    assert.equal(isValidVaultRoot(plain), false);
  });

  it("returns false for a nested directory inside a vault", () => {
    const vault = makeVaultRoot();
    const nested = makeNestedDir(vault);
    assert.equal(isValidVaultRoot(nested), false);
  });

  it("returns false for a non-existent directory", () => {
    assert.equal(isValidVaultRoot("/does/not/exist/ever"), false);
  });
});

// ---------------------------------------------------------------------------
// resolveVaultRoot — unit tests
// ---------------------------------------------------------------------------

describe("resolveVaultRoot", () => {
  it("uses explicit vault root when it is a valid vault root (first positional)", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot([vault, "my query"], () => makePlainDir());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, ["my query"]);
  });

  it("returns all positionals as remainder when falling back to cwd", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot(["my query"], () => vault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, ["my query"]);
  });

  it("falls back to cwd when no positionals are supplied and cwd is a vault root", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot([], () => vault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, []);
  });

  it("fails when first positional is not a vault root and cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = resolveVaultRoot(["just a query"], () => plain);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(result.outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("fails when cwd is a nested directory inside a vault (not the root)", () => {
    const vault = makeVaultRoot();
    const nested = makeNestedDir(vault);
    const result = resolveVaultRoot(["my query"], () => nested);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertErrorCode(result.outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("prefers explicit vault root over a valid cwd vault", () => {
    const explicitVault = makeVaultRoot();
    const cwdVault = makeVaultRoot();
    const result = resolveVaultRoot([explicitVault, "my query"], () => cwdVault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    // Must use the explicit vault, not the cwd vault
    assert.equal(result.vaultRoot, explicitVault);
    assert.deepEqual(result.remainder, ["my query"]);
  });
});

// ---------------------------------------------------------------------------
// handleRetrieve — integration-level tests
// ---------------------------------------------------------------------------

describe("handleRetrieve — query mode", () => {
  it("returns USAGE_MISSING_ARGS when no args supplied", () => {
    const outcome = handleRetrieve([], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "USAGE_MISSING_ARGS");
  });

  it("returns VAULT_ROOT_NOT_FOUND when cwd is not a vault root and single query supplied", () => {
    const plain = makePlainDir();
    const outcome = handleRetrieve(["my query"], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("returns USAGE_MISSING_QUERY when explicit vault root supplied but no query", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve([vault], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "USAGE_MISSING_QUERY");
  });

  it("reaches NOT_YET_IMPLEMENTED when explicit vault root and query supplied", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve([vault, "my query"], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("reaches NOT_YET_IMPLEMENTED when cwd is vault root and query supplied (cwd fallback)", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve(["my query"], () => vault);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });
});

describe("handleRetrieve — eval mode", () => {
  it("returns VAULT_ROOT_NOT_FOUND when --eval supplied with no vault root and bad cwd", () => {
    const plain = makePlainDir();
    const outcome = handleRetrieve(["--eval"], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("reaches NOT_YET_IMPLEMENTED when --eval with valid cwd vault root (cwd fallback)", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve(["--eval"], () => vault);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("reaches NOT_YET_IMPLEMENTED when --eval with explicit vault root", () => {
    const vault = makeVaultRoot();
    const plain = makePlainDir();
    const outcome = handleRetrieve(["--eval", vault], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("returns VAULT_ROOT_NOT_FOUND when --eval with explicit non-vault path and bad cwd", () => {
    const plain = makePlainDir();
    const anotherPlain = makePlainDir();
    const outcome = handleRetrieve(["--eval", anotherPlain], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// CLI integration test — run built binary
// ---------------------------------------------------------------------------

describe("CLI integration — okv retrieve root resolution", () => {
  const cliPath = join(projectRoot, "dist", "main.js");

  it("exits with non-zero code and VAULT_ROOT_NOT_FOUND when cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "some query"], {
      cwd: plain,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /VAULT_ROOT_NOT_FOUND/);
  });

  it("exits with non-zero code and VAULT_ROOT_NOT_FOUND for --eval when cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "--eval"], {
      cwd: plain,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /VAULT_ROOT_NOT_FOUND/);
  });

  it("outputs NOT_YET_IMPLEMENTED when cwd is a valid vault root with query", () => {
    const vault = makeVaultRoot();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "agent workflows"], {
      cwd: vault,
      encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /NOT_YET_IMPLEMENTED/);
  });
});
