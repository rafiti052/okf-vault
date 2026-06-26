import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode, dispatch, parseArgs, type CliSuccess } from "../../dist/cli/cli.js";
import { LOG_PATH, MANIFEST_RELATIVE_PATH } from "../../dist/vault/constants.js";
import { initializeVault, loadManifest, manifestRevision } from "../../dist/vault/manifest.js";
import { runGit } from "../../dist/vault/git.js";
import {
  acquireVaultLock,
  commitStagedSource,
  readTransactionJournal,
  readVaultLock,
  recoverVault,
  writeFailureJournal,
  TRANSACTION_JOURNAL_VERSION,
} from "../../dist/vault/transaction.js";

const fixturesDir = join(process.cwd(), "test", "fixtures");
const notesDir = join(fixturesDir, "notes");
const envelopesDir = join(fixturesDir, "envelopes");

function prepareVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), "okf-recover-"));
  initializeVault(vaultRoot);
  return vaultRoot;
}

function stageArticle(vaultRoot: string, runId: string) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId, "notes");
  mkdirSync(stagingDir, { recursive: true });
  copyFileSync(join(notesDir, "article-valid.md"), join(stagingDir, "sample-article.md"));
}

describe("interrupted transaction recovery integration", () => {
  it("restores managed paths from journal snapshots without touching unrelated files", () => {
    const vaultRoot = prepareVault();
    writeFileSync(join(vaultRoot, "unrelated.txt"), "preserve\n", "utf8");
    const snapshot = {
      manifest: readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"),
      log: readFileSync(join(vaultRoot, LOG_PATH), "utf8"),
      notes: {},
    };

    writeFileSync(join(vaultRoot, LOG_PATH), "# partial write\n", "utf8");
    writeFileSync(join(vaultRoot, "notes/partial.md"), "# partial\n", "utf8");
    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-interrupted",
      source_key: "local:/tmp/sources/sample-article.md",
      phase: "commit",
      failed_at: "2026-06-19T12:00:00.000Z",
      error_code: "TRANSACTION_FAILED",
      error_message: "interrupted before commit",
      snapshot,
      installed_paths: ["notes/partial.md", MANIFEST_RELATIVE_PATH, LOG_PATH],
    });
    acquireVaultLock(vaultRoot, "run-interrupted", manifestRevision(loadManifest(vaultRoot)));

    const outcome = dispatch(parseArgs(["recover", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), snapshot.log);
    assert.equal(existsSync(join(vaultRoot, "notes/partial.md")), false);
    assert.equal(readFileSync(join(vaultRoot, "unrelated.txt"), "utf8"), "preserve\n");
    assert.equal(readVaultLock(vaultRoot), undefined);
    assert.equal(readTransactionJournal(vaultRoot), undefined);
  });

  it("allows a subsequent commit after recovery clears journal and lock state", () => {
    const vaultRoot = prepareVault();
    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-retry",
      source_key: "local:/tmp/sources/sample-article.md",
      phase: "install",
      failed_at: "2026-06-19T12:00:00.000Z",
      error_code: "TRANSACTION_FAILED",
      error_message: "install failed",
      snapshot: {
        manifest: readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"),
        log: readFileSync(join(vaultRoot, LOG_PATH), "utf8"),
        notes: {},
      },
      installed_paths: [],
    });

    recoverVault(vaultRoot);
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-retry-commit");
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    commitStagedSource({
      vaultRoot,
      runId: "run-retry-commit",
      envelopePath: join(envelopesDir, "article-local.json"),
      expectedRevision: revision,
    });

    assert.notEqual(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), beforeHead);
    assert.equal(loadManifest(vaultRoot).sources.length, 1);
  });

  it("exits 0 on recover when no journal or lock artifacts remain", () => {
    const vaultRoot = prepareVault();
    const outcome = dispatch(parseArgs(["recover", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    assert.equal((outcome.result as CliSuccess).data.recovered, false);
  });
});
