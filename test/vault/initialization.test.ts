import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  GITIGNORE_ENTRY,
  MANIFEST_RELATIVE_PATH,
  NOTES_INDEX_PATH,
  ROOT_INDEX_PATH,
  TOPICS_INDEX_PATH,
} from "../../dist/vault/constants.js";
import { initializeVault, saveManifest, createEmptyManifest } from "../../dist/vault/manifest.js";
import { isGitRepository, runGit } from "../../dist/vault/git.js";
import { ExitCode, dispatch, parseArgs, type CliSuccess } from "../../dist/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const VALID_SHA = "a".repeat(64);
const VALID_SHA_B = "b".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

describe("vault initialization", () => {
  it("creates the populated layout, ignore rules, manifest, repository, and baseline commit", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-init-"));
    const result = initializeVault(vaultRoot);

    assert.equal(existsSync(join(vaultRoot, ROOT_INDEX_PATH)), true);
    assert.equal(existsSync(join(vaultRoot, "log.md")), true);
    assert.equal(existsSync(join(vaultRoot, NOTES_INDEX_PATH)), true);
    assert.equal(existsSync(join(vaultRoot, TOPICS_INDEX_PATH)), true);
    assert.equal(existsSync(join(vaultRoot, MANIFEST_RELATIVE_PATH)), true);
    assert.equal(existsSync(join(vaultRoot, ".okf-vault/reviews/.gitkeep")), true);
    assert.equal(existsSync(join(vaultRoot, ".okf-vault/tmp")), true);
    assert.match(readFileSync(join(vaultRoot, ".gitignore"), "utf8"), new RegExp(GITIGNORE_ENTRY));
    assert.equal(isGitRepository(vaultRoot), true);
    assert.equal(result.committed, true);
    assert.ok(result.commit);

    const status = runGit(vaultRoot, ["status", "--porcelain"]);
    assert.equal(status.stdout.trim(), "");
  });

  it("is idempotent and fails closed on conflicting managed files", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-reinit-"));
    initializeVault(vaultRoot);
    const second = initializeVault(vaultRoot);
    assert.equal(second.idempotent, true);

    writeFileSync(join(vaultRoot, ROOT_INDEX_PATH), "# user content\n", "utf8");
    assert.throws(() => initializeVault(vaultRoot), /Managed file conflict/);
    assert.notEqual(readFileSync(join(vaultRoot, ROOT_INDEX_PATH), "utf8"), "# overwritten\n");
  });

  it("never stages or commits unrelated files in an existing repository", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-existing-"));
    runGit(vaultRoot, ["init"]);
    writeFileSync(join(vaultRoot, "unrelated.txt"), "keep me untracked\n", "utf8");

    initializeVault(vaultRoot);

    const status = runGit(vaultRoot, ["status", "--porcelain"]);
    assert.match(status.stdout, /\?\? unrelated\.txt/);
    assert.doesNotMatch(status.stdout, /unrelated\.txt.*[AM]/);
  });
});

describe("init and inspect CLI integration", () => {
  it("reports new, already-processed, and changed-conflict outcomes from persisted state", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-init-"));
    const initOutcome = dispatch(parseArgs(["init", vaultRoot]));
    assert.equal(initOutcome.exitCode, ExitCode.SUCCESS);

    const localPath = join(vaultRoot, "sources", "article.md");
    mkdirSync(join(vaultRoot, "sources"), { recursive: true });
    writeFileSync(localPath, "article", "utf8");

    const newOutcome = dispatch(parseArgs(["inspect", vaultRoot, "local", localPath, VALID_SHA]));
    assert.equal(newOutcome.exitCode, ExitCode.SUCCESS);
    assert.equal(newOutcome.result?.status, "ok");
    const newData = (newOutcome.result as CliSuccess).data as {
      outcome: string;
      source_key: string;
    };
    assert.equal(newData.outcome, "new");

    saveManifest(vaultRoot, {
      ...createEmptyManifest(),
      sources: [
        {
          source_key: newData.source_key,
          kind: "local",
          origin: localPath,
          content_sha256: VALID_SHA,
          contract_version: "okf-note-contract/1.0.0",
          status: "committed",
          note_path: "notes/article.md",
          commit: "abc1234",
          processed_at: VALID_TS,
        },
      ],
    });

    const processedOutcome = dispatch(
      parseArgs(["inspect", vaultRoot, "local", localPath, VALID_SHA]),
    );
    assert.equal(processedOutcome.exitCode, ExitCode.SUCCESS);
    assert.equal(
      ((processedOutcome.result as CliSuccess).data as { outcome: string }).outcome,
      "already_processed",
    );

    const conflictOutcome = dispatch(
      parseArgs(["inspect", vaultRoot, "local", localPath, VALID_SHA_B]),
    );
    assert.equal(conflictOutcome.exitCode, ExitCode.CONFLICT);
    assert.equal(
      ((conflictOutcome.result as CliSuccess).data as { outcome: string }).outcome,
      "changed_conflict",
    );
  });

  it("runs init through the compiled executable", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-bin-init-"));
    const bin = join(root, "dist", "main.js");
    const result = spawnSync(process.execPath, [bin, "init", vaultRoot], { encoding: "utf8" });
    assert.equal(result.status, ExitCode.SUCCESS);
    assert.match(result.stdout, /"status":"ok"/);
    assert.equal(existsSync(join(vaultRoot, MANIFEST_RELATIVE_PATH)), true);
  });
});
