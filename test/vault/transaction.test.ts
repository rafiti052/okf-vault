import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli/cli.js";
import {
  LOG_PATH,
  MANIFEST_RELATIVE_PATH,
  NOTE_CONTRACT_VERSION,
  SOURCE_SPANS_DIR,
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
  captureManagedSnapshot,
  commitStagedSource,
  purgeCommittedSource,
  readTransactionJournal,
  readVaultLock,
  recoverVault,
  restoreManagedSnapshot,
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

function stageProfileNote(vaultRoot: string, runId: string, fixtureName: string, noteName: string) {
  const stagingDir = join(vaultRoot, ".okf-vault", "tmp", runId);
  const targetDir = join(stagingDir, dirname(noteName));
  mkdirSync(targetDir, { recursive: true });
  copyFileSync(join(notesDir, fixtureName), join(stagingDir, noteName));
  return stagingDir;
}

function installedSourceSpanPaths(vaultRoot: string): string[] {
  const rootPath = join(vaultRoot, SOURCE_SPANS_DIR);
  const paths: string[] = [];
  const walk = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      const relativePath = join(relativeDirectory, entry.name).split("\\").join("/");
      if (entry.isDirectory()) {
        walk(fullPath, relativePath);
      } else if (entry.isFile()) {
        paths.push(relativePath);
      }
    }
  };
  walk(rootPath, SOURCE_SPANS_DIR);
  return paths.sort();
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

  it("reports and rejects untracked and staged source-span documents as managed conflicts", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-dirty-span");
    const spanPath = `${SOURCE_SPANS_DIR}/example/span-001.md`;
    mkdirSync(dirname(join(vaultRoot, spanPath)), { recursive: true });
    writeFileSync(join(vaultRoot, spanPath), "# Source span\n", "utf8");

    assert.deepEqual(getManagedPathStatus(vaultRoot), {
      clean: false,
      dirtyPaths: [spanPath],
    });

    assert.equal(runGit(vaultRoot, ["add", "--", spanPath]).status, 0);
    assert.deepEqual(getManagedPathStatus(vaultRoot), {
      clean: false,
      dirtyPaths: [spanPath],
    });

    const outcome = dispatch(
      parseArgs([
        "commit",
        vaultRoot,
        "run-dirty-span",
        join(envelopesDir, "article-local.json"),
        revision,
      ]),
    );
    assert.equal(outcome.exitCode, ExitCode.CONFLICT);
    assert.equal(outcome.result?.status, "error");
    if (outcome.result?.status === "error") {
      assert.equal(outcome.result.code, "MANAGED_PATH_CONFLICT");
      assert.equal(outcome.result.details?.path, spanPath);
      assert.deepEqual(outcome.result.details?.dirty_paths, [spanPath]);
    }
  });
});

describe("managed source-span snapshots", () => {
  it("captures installed source-span documents recursively", () => {
    const vaultRoot = prepareVault();
    const spanPath = `${SOURCE_SPANS_DIR}/sample-article/span-001.md`;
    mkdirSync(dirname(join(vaultRoot, spanPath)), { recursive: true });
    writeFileSync(join(vaultRoot, spanPath), "# Existing source span\n", "utf8");

    const snapshot = captureManagedSnapshot(vaultRoot, "notes/sample-article.md");

    assert.deepEqual(snapshot.source_spans, {
      [spanPath]: "# Existing source span\n",
    });
  });

  it("restores prior source-span bytes and removes documents absent from the snapshot", () => {
    const vaultRoot = prepareVault();
    const existingSpanPath = `${SOURCE_SPANS_DIR}/sample-article/span-001.md`;
    const partialSpanPath = `${SOURCE_SPANS_DIR}/sample-article/span-002.md`;
    mkdirSync(dirname(join(vaultRoot, existingSpanPath)), { recursive: true });
    writeFileSync(join(vaultRoot, existingSpanPath), "# Before transaction\n", "utf8");
    const snapshot = captureManagedSnapshot(vaultRoot, "notes/sample-article.md");

    writeFileSync(join(vaultRoot, existingSpanPath), "# Mutated\n", "utf8");
    writeFileSync(join(vaultRoot, partialSpanPath), "# Partial install\n", "utf8");

    restoreManagedSnapshot(vaultRoot, snapshot);

    assert.equal(readFileSync(join(vaultRoot, existingSpanPath), "utf8"), "# Before transaction\n");
    assert.equal(existsSync(join(vaultRoot, partialSpanPath)), false);
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
    assert.equal(existsSync(join(vaultRoot, "notes/sample-article.md")), false);
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), []);
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
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), []);
  });

  it("restores the previous source-span tree when a transaction fails before commit", () => {
    const vaultRoot = prepareVault();
    const existingSpanPath = `${SOURCE_SPANS_DIR}/sample-article/span-001.md`;
    const partialSpanPath = `${SOURCE_SPANS_DIR}/sample-article/span-002.md`;
    mkdirSync(dirname(join(vaultRoot, existingSpanPath)), { recursive: true });
    writeFileSync(join(vaultRoot, existingSpanPath), "# Before transaction\n", "utf8");
    assert.equal(runGit(vaultRoot, ["add", "--", existingSpanPath]).status, 0);
    assert.equal(runGit(vaultRoot, ["commit", "-m", "seed source span"]).status, 0);
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-span-commit-fail");

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-span-commit-fail",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            createCommit: () => {
              writeFileSync(join(vaultRoot, existingSpanPath), "# Mutated\n", "utf8");
              writeFileSync(join(vaultRoot, partialSpanPath), "# Partial install\n", "utf8");
              throw new Error("simulated span-aware commit failure");
            },
          },
        }),
      /simulated span-aware commit failure/,
    );

    assert.equal(readFileSync(join(vaultRoot, existingSpanPath), "utf8"), "# Before transaction\n");
    assert.equal(existsSync(join(vaultRoot, partialSpanPath)), false);
    assert.deepEqual(readTransactionJournal(vaultRoot)?.snapshot.source_spans, {
      [existingSpanPath]: "# Before transaction\n",
    });
  });

  it("restores the previous HEAD and removes partial span state when amend fails", () => {
    const vaultRoot = prepareVault();
    const revision = manifestRevision(loadManifest(vaultRoot));
    stageArticle(vaultRoot, "run-amend-fail");
    const beforeHead = runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim();

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: "run-amend-fail",
          envelopePath: join(envelopesDir, "article-local.json"),
          expectedRevision: revision,
          hooks: {
            amendCommit: () => {
              throw new Error("simulated amend failure");
            },
          },
        }),
      /simulated amend failure/,
    );

    assert.equal(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), beforeHead);
    assert.equal(loadManifest(vaultRoot).sources.length, 0);
    assert.equal(existsSync(join(vaultRoot, "notes/sample-article.md")), false);
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), []);
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
  it("creates exactly one commit containing the note, span docs, manifest index, and log", () => {
    const vaultRoot = prepareVault();
    writeFileSync(join(vaultRoot, "unrelated.txt"), "leave alone\n", "utf8");
    const revision = manifestRevision(loadManifest(vaultRoot));
    const stagingDir = stageArticle(vaultRoot, "run-success");
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
    assert.deepEqual(
      changed,
      [
        LOG_PATH,
        MANIFEST_RELATIVE_PATH,
        "notes/sample-article.md",
        ...result.source_span_paths,
      ].sort(),
    );

    const record = loadManifest(vaultRoot).sources[0];
    assert.equal(record?.status, "committed");
    assert.equal(result.commit, afterHead);
    assert.match(record?.commit ?? "", /^[a-f0-9]{40}$/);
    assert.equal(result.source_profile, "article");
    assert.equal(result.source_span_count, 1);
    assert.deepEqual(
      record?.source_span_index?.spans.map((span) => span.path),
      result.source_span_paths,
    );
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), result.source_span_paths);
    for (const span of record?.source_span_index?.spans ?? []) {
      const content = readFileSync(join(vaultRoot, span.path), "utf8");
      assert.equal(createHash("sha256").update(content).digest("hex"), span.sha256);
      assert.equal(runGit(vaultRoot, ["show", `${afterHead}:${span.path}`]).status, 0);
    }
    assert.equal(existsSync(stagingDir), false);
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

describe("profile-complete atomic span commits", () => {
  it("commits indexed source-span trees for article, video, panel, and deck profiles", () => {
    const cases = [
      {
        profile: "article",
        noteFixture: "gold/article/accepted-01.md",
        notePath: "notes/profile-article.md",
        envelopeFixture: "article/accepted-01.json",
        expectedSpanCount: 1,
      },
      {
        profile: "video",
        noteFixture: "gold/video/accepted-01.md",
        notePath: "notes/profile-video.md",
        envelopeFixture: "video/accepted-01.json",
        expectedSpanCount: 4,
      },
      {
        profile: "panel",
        noteFixture: "gold/panel/accepted-01.md",
        notePath: "notes/profile-panel.md",
        envelopeFixture: "panel/accepted-01.json",
        expectedSpanCount: 2,
      },
      {
        profile: "deck",
        noteFixture: "gold/deck/accepted-01.md",
        notePath: "notes/profile-deck.md",
        envelopeFixture: "deck/accepted-01.json",
        expectedSpanCount: 6,
      },
    ] as const;

    for (const testCase of cases) {
      const vaultRoot = prepareVault();
      const runId = `run-${testCase.profile}-commit`;
      stageProfileNote(vaultRoot, runId, testCase.noteFixture, testCase.notePath);
      const result = commitStagedSource({
        vaultRoot,
        runId,
        envelopePath: join(envelopesDir, testCase.envelopeFixture),
        expectedRevision: manifestRevision(loadManifest(vaultRoot)),
      });

      const record = loadManifest(vaultRoot).sources[0];
      assert.equal(result.source_profile, testCase.profile);
      assert.equal(record?.source_span_index?.profile, testCase.profile);
      assert.equal(result.source_span_count, testCase.expectedSpanCount);
      assert.deepEqual(installedSourceSpanPaths(vaultRoot), result.source_span_paths);
      assert.deepEqual(
        record?.source_span_index?.spans.map((span) => span.path),
        result.source_span_paths,
      );
      assert.equal(getManagedPathStatus(vaultRoot).clean, true);
      for (const span of record?.source_span_index?.spans ?? []) {
        const content = readFileSync(join(vaultRoot, span.path), "utf8");
        assert.equal(createHash("sha256").update(content).digest("hex"), span.sha256);
        assert.equal(runGit(vaultRoot, ["show", `${result.commit}:${span.path}`]).status, 0);
      }
    }
  });
});

describe("source-span supersede and logical purge", () => {
  it("explicit supersede replaces stale span docs and index in one new commit", () => {
    const vaultRoot = prepareVault();
    const firstRun = "run-before-supersede";
    stageArticle(vaultRoot, firstRun);
    const first = commitStagedSource({
      vaultRoot,
      runId: firstRun,
      envelopePath: join(envelopesDir, "article-local.json"),
      expectedRevision: manifestRevision(loadManifest(vaultRoot)),
    });
    const firstHead = first.commit;
    const oldSpanPaths = [...first.source_span_paths];

    const changedHash = "b".repeat(64);
    const changedEnvelopePath = join(vaultRoot, "superseded-envelope.json");
    const changedEnvelope = JSON.parse(
      readFileSync(join(envelopesDir, "article-local.json"), "utf8"),
    ) as { content_sha256: string };
    changedEnvelope.content_sha256 = changedHash;
    writeFileSync(changedEnvelopePath, `${JSON.stringify(changedEnvelope, null, 2)}\n`, "utf8");

    const secondRun = "run-after-supersede";
    const secondStaging = stageArticle(vaultRoot, secondRun);
    const stagedNotePath = join(secondStaging, "notes/sample-article.md");
    writeFileSync(
      stagedNotePath,
      readFileSync(stagedNotePath, "utf8").replace("a".repeat(64), changedHash),
      "utf8",
    );
    const revision = manifestRevision(loadManifest(vaultRoot));

    assert.throws(
      () =>
        commitStagedSource({
          vaultRoot,
          runId: secondRun,
          envelopePath: changedEnvelopePath,
          expectedRevision: revision,
        }),
      /content hash changed/,
    );

    const second = commitStagedSource({
      vaultRoot,
      runId: secondRun,
      envelopePath: changedEnvelopePath,
      expectedRevision: revision,
      supersede: true,
    });
    const record = loadManifest(vaultRoot).sources[0];

    assert.notDeepEqual(second.source_span_paths, oldSpanPaths);
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), second.source_span_paths);
    assert.deepEqual(
      record?.source_span_index?.spans.map((span) => span.path),
      second.source_span_paths,
    );
    for (const oldPath of oldSpanPaths) {
      assert.equal(existsSync(join(vaultRoot, oldPath)), false);
      assert.equal(runGit(vaultRoot, ["show", `${firstHead}:${oldPath}`]).status, 0);
    }
    assert.equal(runGit(vaultRoot, ["merge-base", "--is-ancestor", firstHead, "HEAD"]).status, 0);
    assert.equal(
      runGit(vaultRoot, ["rev-list", "--count", `${firstHead}..HEAD`]).stdout.trim(),
      "1",
    );
  });

  it("logical purge removes current note, spans, and manifest record without rewriting history", () => {
    const vaultRoot = prepareVault();
    stageArticle(vaultRoot, "run-before-purge");
    const committed = commitStagedSource({
      vaultRoot,
      runId: "run-before-purge",
      envelopePath: join(envelopesDir, "article-local.json"),
      expectedRevision: manifestRevision(loadManifest(vaultRoot)),
    });
    const beforePurgeHead = committed.commit;
    const sourceKey = loadManifest(vaultRoot).sources[0]!.source_key;

    const purged = purgeCommittedSource({
      vaultRoot,
      runId: "run-purge",
      sourceKey,
      expectedRevision: manifestRevision(loadManifest(vaultRoot)),
    });

    assert.equal(loadManifest(vaultRoot).sources.length, 0);
    assert.equal(existsSync(join(vaultRoot, committed.note_path)), false);
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), []);
    assert.deepEqual(
      purged.removed_paths.sort(),
      [committed.note_path, ...committed.source_span_paths].sort(),
    );
    for (const spanPath of committed.source_span_paths) {
      assert.equal(runGit(vaultRoot, ["show", `${beforePurgeHead}:${spanPath}`]).status, 0);
      assert.notEqual(runGit(vaultRoot, ["show", `HEAD:${spanPath}`]).status, 0);
    }
    assert.equal(
      runGit(vaultRoot, ["merge-base", "--is-ancestor", beforePurgeHead, "HEAD"]).status,
      0,
    );
    assert.equal(
      runGit(vaultRoot, ["rev-list", "--count", `${beforePurgeHead}..HEAD`]).stdout.trim(),
      "1",
    );
  });

  it("restores the note, spans, and manifest index when a purge commit fails", () => {
    const vaultRoot = prepareVault();
    stageArticle(vaultRoot, "run-before-failed-purge");
    const committed = commitStagedSource({
      vaultRoot,
      runId: "run-before-failed-purge",
      envelopePath: join(envelopesDir, "article-local.json"),
      expectedRevision: manifestRevision(loadManifest(vaultRoot)),
    });
    const beforeManifest = loadManifest(vaultRoot);
    const beforeHead = committed.commit;

    assert.throws(
      () =>
        purgeCommittedSource({
          vaultRoot,
          runId: "run-failed-purge",
          sourceKey: beforeManifest.sources[0]!.source_key,
          expectedRevision: manifestRevision(beforeManifest),
          hooks: {
            createCommit: () => {
              throw new Error("simulated purge commit failure");
            },
          },
        }),
      /simulated purge commit failure/,
    );

    assert.equal(runGit(vaultRoot, ["rev-parse", "HEAD"]).stdout.trim(), beforeHead);
    assert.deepEqual(loadManifest(vaultRoot), beforeManifest);
    assert.equal(existsSync(join(vaultRoot, committed.note_path)), true);
    assert.deepEqual(installedSourceSpanPaths(vaultRoot), committed.source_span_paths);
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
