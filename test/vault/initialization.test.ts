import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  lstatSync,
  realpathSync,
} from "node:fs";
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
import {
  initializeVault,
  saveManifest,
  createEmptyManifest,
  installCuratorRule,
} from "../../dist/vault/manifest.js";
import { isGitRepository, runGit } from "../../dist/vault/git.js";
import { ExitCode, dispatch, parseArgs, type CliSuccess } from "../../dist/cli/cli.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const VALID_SHA = "a".repeat(64);
const VALID_SHA_B = "b".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";
const OKV_COMMANDS = [
  "okv-ingest",
  "okv-init",
  "okv-organize",
  "okv-validate",
  "okv-visualize",
  "okv-bootstrap",
  "okv-ingest-check",
] as const;

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
  it("installCuratorRule writes the OKV Cursor rule from the canonical template", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "okf-rule-install-"));
    const rulePath = join(projectRoot, ".cursor", "rules", "okv.mdc");
    const templatePath = join(root, ".agents", "skills", "okf-vault", "templates", "okv.mdc");

    assert.equal(installCuratorRule(projectRoot, root), true);
    assert.equal(existsSync(rulePath), true);
    assert.equal(readFileSync(rulePath, "utf8"), readFileSync(templatePath, "utf8"));
    assert.match(readFileSync(rulePath, "utf8"), /\/okv-ingest/);
    assert.match(readFileSync(rulePath, "utf8"), /okv <command> --json/);

    assert.equal(installCuratorRule(projectRoot, root), false);
  });

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

  it("no-arg init from repo root creates knowledge vault and installs adapters", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "okf-project-init-"));
    const originalCwd = process.cwd();
    const canonicalSkill = join(root, ".agents", "skills", "okf-vault");

    try {
      process.chdir(projectRoot);
      const outcome = dispatch(parseArgs(["init"]));
      assert.equal(outcome.exitCode, ExitCode.SUCCESS);

      const data = (outcome.result as CliSuccess).data as {
        vault_root: string;
        project_root: string;
        adapters_installed: boolean;
        adapter_links_created: number;
        adapter_links_skipped: number;
        curator_rule_installed: boolean;
        curator_rule_path: string;
        legacy_paths_removed: number;
        legacy_removed: string[];
        linked: string[];
        skipped: string[];
      };
      assert.equal(data.adapters_installed, true);
      assert.equal(data.adapter_links_created, 16);
      assert.equal(data.adapter_links_skipped, 0);
      assert.equal(data.curator_rule_installed, true);
      assert.equal(
        realpathSync(data.curator_rule_path),
        realpathSync(join(projectRoot, ".cursor", "rules", "okv.mdc")),
      );
      assert.equal(data.legacy_paths_removed, 0);
      assert.deepEqual(data.legacy_removed, []);
      assert.equal(data.linked.length, 16);
      assert.equal(data.skipped.length, 0);
      assert.equal(realpathSync(data.project_root), realpathSync(projectRoot));
      assert.equal(realpathSync(data.vault_root), realpathSync(join(projectRoot, "knowledge")));
      assert.equal(existsSync(join(projectRoot, "knowledge", MANIFEST_RELATIVE_PATH)), true);

      const cursorSkill = join(projectRoot, ".cursor", "skills", "okf-vault");
      const claudeSkill = join(projectRoot, ".claude", "skills", "okf-vault");
      assert.equal(existsSync(cursorSkill), true);
      assert.equal(existsSync(claudeSkill), true);
      assert.equal(lstatSync(cursorSkill).isSymbolicLink(), true);
      assert.equal(lstatSync(claudeSkill).isSymbolicLink(), true);
      assert.equal(realpathSync(cursorSkill), realpathSync(canonicalSkill));
      assert.equal(realpathSync(claudeSkill), realpathSync(canonicalSkill));
      for (const command of OKV_COMMANDS) {
        const cursorCommand = join(projectRoot, ".cursor", "skills", command, "SKILL.md");
        const claudeCommand = join(projectRoot, ".claude", "commands", `${command}.md`);
        assert.equal(lstatSync(cursorCommand).isSymbolicLink(), true);
        assert.equal(lstatSync(claudeCommand).isSymbolicLink(), true);
      }
      assert.equal(existsSync(join(projectRoot, ".cursor", "rules", "okv.mdc")), true);
      assert.equal(existsSync(join(projectRoot, ".cursor", "rules", "okf-vault.mdc")), false);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("explicit init path creates vault only without adapters", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "okf-explicit-init-"));
    const vaultRoot = join(projectRoot, "custom-vault");
    const outcome = dispatch(parseArgs(["init", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.SUCCESS);

    const data = (outcome.result as CliSuccess).data as { adapters_installed?: boolean };
    assert.equal(data.adapters_installed, undefined);
    assert.equal(existsSync(join(vaultRoot, MANIFEST_RELATIVE_PATH)), true);
    assert.equal(existsSync(join(projectRoot, ".cursor", "skills", "okf-vault")), false);
    assert.equal(existsSync(join(projectRoot, ".cursor", "rules", "okv.mdc")), false);
    assert.equal(existsSync(join(projectRoot, ".claude", "skills", "okf-vault")), false);
  });

  it("no-arg init sweeps legacy curator rule and reports removed paths", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "okf-legacy-rule-init-"));
    const legacyRule = join(projectRoot, ".cursor", "rules", "okf-vault.mdc");
    const originalCwd = process.cwd();

    mkdirSync(dirname(legacyRule), { recursive: true });
    writeFileSync(legacyRule, "legacy rule\n", "utf8");

    try {
      process.chdir(projectRoot);
      const outcome = dispatch(parseArgs(["init"]));
      assert.equal(outcome.exitCode, ExitCode.SUCCESS);

      const data = (outcome.result as CliSuccess).data as {
        legacy_paths_removed: number;
        legacy_removed: string[];
        removed: string[];
      };
      assert.equal(data.legacy_paths_removed, 1);
      const expectedLegacyRule = join(
        realpathSync(projectRoot),
        ".cursor",
        "rules",
        "okf-vault.mdc",
      );
      assert.deepEqual(data.legacy_removed, [expectedLegacyRule]);
      assert.deepEqual(data.removed, [expectedLegacyRule]);
      assert.equal(existsSync(legacyRule), false);
      assert.equal(existsSync(join(projectRoot, ".cursor", "rules", "okv.mdc")), true);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("no-arg init is idempotent on re-run", () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "okf-project-reinit-"));
    const originalCwd = process.cwd();

    try {
      process.chdir(projectRoot);
      const first = dispatch(parseArgs(["init"]));
      assert.equal(first.exitCode, ExitCode.SUCCESS);
      const firstData = (first.result as CliSuccess).data as { curator_rule_installed: boolean };
      assert.equal(firstData.curator_rule_installed, true);

      const second = dispatch(parseArgs(["init"]));
      assert.equal(second.exitCode, ExitCode.SUCCESS);
      const secondData = (second.result as CliSuccess).data as {
        idempotent: boolean;
        curator_rule_installed: boolean;
        adapter_links_created: number;
        adapter_links_skipped: number;
        legacy_paths_removed: number;
        legacy_removed: string[];
        linked: string[];
        skipped: string[];
      };
      assert.equal(secondData.idempotent, true);
      assert.equal(secondData.curator_rule_installed, false);
      assert.equal(secondData.adapter_links_created, 0);
      assert.equal(secondData.adapter_links_skipped, 16);
      assert.equal(secondData.legacy_paths_removed, 0);
      assert.deepEqual(secondData.legacy_removed, []);
      assert.equal(secondData.linked.length, 0);
      assert.equal(secondData.skipped.length, 16);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
