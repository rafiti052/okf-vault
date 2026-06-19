import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli.js";
import {
  LOG_PATH,
  MANIFEST_RELATIVE_PATH,
  NOTE_CONTRACT_VERSION,
} from "../../dist/vault/constants.js";
import {
  initializeVault,
  loadManifest,
  manifestRevision,
  saveManifest,
} from "../../dist/vault/manifest.js";
import { runGit, getManagedPathStatus } from "../../dist/vault/git.js";
import {
  acquireVaultLock,
  commitStagedSource,
  readTransactionJournal,
  readVaultLock,
  recoverVault,
  writeFailureJournal,
  type ManagedSnapshot,
  TRANSACTION_JOURNAL_VERSION,
} from "../../dist/vault/transaction.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const fixturesDir = join(root, "test", "fixtures");
const notesDir = join(fixturesDir, "notes");
const envelopesDir = join(fixturesDir, "envelopes");
const VALID_SHA = "a".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function stageArticle(vaultRoot: string, runId: string, noteName = "notes/sample-article.md") {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(noteName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(notesDir, "article-valid.md"), join(stagingDir, noteName));
  return stagingDir;
}

function prepareVault() {
  const vaultRoot = mkdtempSync(join(tmpdir(), "okf-txn-"));
  initializeVault(vaultRoot);
  return vaultRoot;
}

describe("vault lock and preflight", () => {
  it("returns exit class 4 when a live vault lock already exists", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    const manifestBefore = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    stageArticle(vaultRoot, "run-lock");
    acquireVaultLock(vaultRoot, "existing-run", revision);

    const outcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-lock",
        join(envelopesDir, "article-local.json"),
        revision,
      ]),
    );
    assert.equal(outcome.exitCode, ExitCode.CONFLICT);
    assert.equal(outcome.result?.status, "error");
    assert.equal(outcome.result?.code, "VAULT_LOCKED");
    assert.equal(readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"), manifestBefore);
  });
});

describe("manifest revision revalidation", () => {
  it("aborts before installation when revision drifts after validation", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-revision");

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-revision",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            afterValidation: (root) => {
              saveManifest(root, {
                ...loadManifest(root),
                sources: [
                  {
                    source_key: "local:/tmp/skipped.md",
                    kind: "local",
                    origin: "/tmp/skipped.md",
                    content_sha256: VALID_SHA,
                    contract_version: NOTE_CONTRACT_VERSION,
                    status: "skipped",
                    skip_reason: "revision drift test",
                    processed_at: VALID_TS,
                  },
                ],
              });
            },
          },
        }),
      /Manifest revision mismatch/,
    );

    assert.equal(existsSync(join(vaultRoot, "notes/sample-article.md")), false);
    assert.equal(
      loadManifest(vaultRoot).sources.some((record) => record.status === "committed"),
      false,
    );
  });
});

describe("managed path preflight", () => {
  it("aborts with a path-specific conflict when an unrelated managed path is dirty", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-dirty");
    writeFileSync(join(vaultRoot, LOG_PATH), "# user edit\n", "utf8");

    const outcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-dirty",
        join(envelopesDir, "article-local.json"),
        revision,
      ]),
    );
    assert.equal(outcome.exitCode, ExitCode.CONFLICT);
    assert.equal(outcome.result?.status, "error");
    if (outcome.result?.status === "error") {
      assert.equal(outcome.result.code, "MANAGED_PATH_CONFLICT");
      assert.match(outcome.result.message, /log\.md/);
    }
  });
});

describe("install rollback", () => {
  it("restores pre-transaction note, manifest, and log contents after rename failure", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-rename");
    writeFileSync(
      join(vaultRoot, LOG_PATH),
      `${readFileSync(join(vaultRoot, LOG_PATH), "utf8")}seed entry\n`,
      "utf8",
    );
    runGit(vaultRoot, ["add", LOG_PATH]);
    runGit(vaultRoot, ["commit", "-m", "seed log"]);

    const beforeManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const beforeLog = readFileSync(join(vaultRoot, LOG_PATH), "utf8");

    let renameCalls = 0;
    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-rename",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            renameSync: (from, to) => {
              renameCalls += 1;
              if (renameCalls === 2) {
                throw new Error("simulated rename failure");
              }
              renameSync(from, to);
            },
          },
        }),
      /simulated rename failure/,
    );

    assert.equal(readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"), beforeManifest);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), beforeLog);
    assert.ok(readTransactionJournal(vaultRoot));
  });
});

describe("commit rollback", () => {
  it("rolls back managed files and leaves no committed manifest record after git commit failure", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-commit-fail");
    const beforeManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const beforeLog = readFileSync(join(vaultRoot, LOG_PATH), "utf8");

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-commit-fail",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            createCommit: () => {
              throw new Error("simulated git commit failure");
            },
          },
        }),
      /simulated git commit failure/,
    );

    assert.equal(readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"), beforeManifest);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), beforeLog);
    assert.equal(loadManifest(vaultRoot).sources.length, 0);
  });
});

describe("journal recovery", () => {
  it("removes partial installs and clears stale lock files idempotently", () => {
    const vaultRoot = prepareVault();
    const snapshot: ManagedSnapshot = {
      manifest: readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"),
      log: readFileSync(join(vaultRoot, LOG_PATH), "utf8"),
      notes: {},
    };
    writeFileSync(join(vaultRoot, "notes/partial.md"), "# partial\n", "utf8");
    writeFileSync(join(vaultRoot, LOG_PATH), "# mutated log\n", "utf8");
    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-recover",
      source_key: "local:/tmp/sources/sample-article.md",
      phase: "commit",
      failed_at: VALID_TS,
      error_code: "TRANSACTION_FAILED",
      error_message: "interrupted",
      snapshot,
      installed_paths: ["notes/partial.md", MANIFEST_RELATIVE_PATH, LOG_PATH],
    });
    acquireVaultLock(vaultRoot, "run-recover", manifestRevision(loadManifest(vaultRoot)));

    const first = recoverVault(vaultRoot);
    assert.equal(first.recovered, true);
    assert.equal(first.run_id, "run-recover");
    assert.equal(existsSync(join(vaultRoot, "notes/partial.md")), false);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), snapshot.log);
    assert.equal(readVaultLock(vaultRoot), undefined);
    assert.equal(readTransactionJournal(vaultRoot), undefined);

    const second = recoverVault(vaultRoot);
    assert.equal(second.recovered, false);
  });
});

describe("successful commit integration", () => {
  it("creates exactly one commit touching only the note, manifest, and log", () => {
    const vaultRoot = prepareVault();
    writeFileSync(join(vaultRoot, "unrelated.txt"), "leave alone\n", "utf8");
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-success");
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const result = commitStagedSource({
      vaultRoot,
      runId: "run-success",
      envelopePath: join(envelopesDir, "article-local.json"),
      expectedRevision: revision,
    });

    const afterHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();
    assert.notEqual(afterHead, beforeHead);
    assert.equal(
      runGit(vaultRoot, ["rev-list", "--count", `${beforeHead}..HEAD`]).stdout.trim(),
      "1",
    );
    assert.equal(result.note_path, "notes/sample-article.md");
    assert.match(result.commit, /^[a-f0-9]{40}$/);

    const changed = runGit(vaultRoot, ["show", "--name-only", "--pretty=format:", afterHead])
      .stdout.split("\n")
      .filter(Boolean)
      .sort();
    assert.deepEqual(changed, [LOG_PATH, MANIFEST_RELATIVE_PATH, "notes/sample-article.md"].sort());

    const record = loadManifest(vaultRoot).sources[0];
    assert.equal(record?.status, "committed");
    assert.equal(result.commit, afterHead);
    assert.match(record?.commit ?? "", /^[a-f0-9]{40}$/);
    assert.equal(getManagedPathStatus(vaultRoot).clean, true);
    assert.equal(existsSync(join(vaultRoot, "unrelated.txt")), true);
    assert.match(runGit(vaultRoot, ["status", "--porcelain"]).stdout, /\?\? unrelated\.txt/);
  });

  it("leaves Git HEAD unchanged when failure happens before installation", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-preflight-fail");
    writeFileSync(join(vaultRoot, LOG_PATH), "# dirty\n", "utf8");
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    const outcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-preflight-fail",
        join(envelopesDir, "article-local.json"),
        revision,
      ]),
    );
    assert.equal(outcome.exitCode, ExitCode.CONFLICT);
    assert.equal(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), beforeHead);
    assert.equal(loadManifest(vaultRoot).sources.length, 0);
  });

  it("restores managed path bytes after install-but-before-commit failure", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-install-fail");
    const beforeManifest = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    const beforeLog = readFileSync(join(vaultRoot, LOG_PATH), "utf8");

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-install-fail",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            createCommit: () => {
              throw new Error("simulated git commit failure");
            },
          },
        }),
      /simulated git commit failure/,
    );

    assert.equal(readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"), beforeManifest);
    assert.equal(readFileSync(join(vaultRoot, LOG_PATH), "utf8"), beforeLog);
    assert.equal(existsSync(join(vaultRoot, "notes/sample-article.md")), false);
  });
});

describe("commit and recover CLI handlers", () => {
  it("returns deterministic JSON envelopes for recover after an interrupted run", () => {
    const vaultRoot = prepareVault();
    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-cli-recover",
      source_key: "local:/tmp/sources/sample-article.md",
      phase: "install",
      failed_at: VALID_TS,
      error_code: "TRANSACTION_FAILED",
      error_message: "interrupted",
      snapshot: {
        manifest: readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"),
        log: readFileSync(join(vaultRoot, LOG_PATH), "utf8"),
        notes: {},
      },
      installed_paths: [],
    });

    const recoverOutcome = dispatch(parseArgs(["recover", vaultRoot]));
    assert.equal(recoverOutcome.exitCode, ExitCode.SUCCESS);
    assert.equal(recoverOutcome.result?.status, "ok");
    assert.equal(recoverOutcome.result?.command, "recover");

    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-cli-commit");
    const commitOutcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-cli-commit",
        join(envelopesDir, "article-local.json"),
        revision,
      ]),
    );
    assert.equal(commitOutcome.exitCode, ExitCode.SUCCESS);
    assert.equal(commitOutcome.result?.status, "ok");
    assert.equal(commitOutcome.result?.command, "commit");
  });
});

describe("compiled executable recovery integration", () => {
  it("returns the vault to a clean committable state after CLI recovery", () => {
    const vaultRoot = prepareVault();
    writeFailureJournal(vaultRoot, {
      schema_version: TRANSACTION_JOURNAL_VERSION,
      run_id: "run-bin-recover",
      source_key: "local:/tmp/sources/sample-article.md",
      phase: "install",
      failed_at: VALID_TS,
      error_code: "TRANSACTION_FAILED",
      error_message: "interrupted",
      snapshot: {
        manifest: readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8"),
        log: readFileSync(join(vaultRoot, LOG_PATH), "utf8"),
        notes: {},
      },
      installed_paths: ["notes/partial.md"],
    });
    writeFileSync(join(vaultRoot, "notes/partial.md"), "# partial\n", "utf8");

    const bin = join(root, "dist", "main.js");
    const recover = spawnSync(process.execPath, [bin, "recover", vaultRoot], { encoding: "utf8" });
    assert.equal(recover.status, ExitCode.SUCCESS);
    assert.match(recover.stdout, /"status":"ok"/);
    assert.equal(existsSync(join(vaultRoot, "notes/partial.md")), false);

    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-after-recover");
    const commit = spawnSync(
      process.execPath,
      [
        bin,
        "commit",
        vaultRoot,
        "run-after-recover",
        join(envelopesDir, "article-local.json"),
        revision,
      ],
      { encoding: "utf8" },
    );
    assert.equal(commit.status, ExitCode.SUCCESS);
    assert.match(commit.stdout, /"status":"ok"/);
  });
});
