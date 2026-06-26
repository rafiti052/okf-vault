import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPath,
  checkRules,
  checkHooks,
  checkVault,
  runDiagnostics,
} from "../../dist/vault/diagnostics.js";
import { MANIFEST_SCHEMA_VERSION } from "../../dist/vault/constants.js";

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(join(tmpdir(), prefix));
}

describe("diagnostics engine", () => {
  describe("checkPath", () => {
    it("returns pass when okv is resolved on PATH and no conflicts exist", () => {
      const tempDir = createTempDir("okv-path-pass-");
      fs.writeFileSync(join(tempDir, "okv"), "", "utf8");

      const results = checkPath(tempDir);
      const okvResult = results.find((r) => r.code === "PATH_OKV_RESOLVED");
      const legacyResult = results.find((r) => r.code === "PATH_LEGACY_CONFLICT");

      assert.ok(okvResult);
      assert.equal(okvResult.status, "pass");
      assert.equal(legacyResult, undefined);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when legacy executables like okf-vault or okv-cli exist in PATH", () => {
      const tempDir = createTempDir("okv-path-fail-");
      fs.writeFileSync(join(tempDir, "okv"), "", "utf8");
      fs.writeFileSync(join(tempDir, "okf-vault"), "", "utf8");
      fs.writeFileSync(join(tempDir, "okv-cli"), "", "utf8");

      const results = checkPath(tempDir);
      const conflicts = results.filter((r) => r.code === "PATH_LEGACY_CONFLICT");
      const okvResult = results.find((r) => r.code === "PATH_OKV_RESOLVED");

      assert.equal(conflicts.length, 2);
      assert.equal(conflicts[0]?.status, "fail");
      assert.equal(conflicts[1]?.status, "fail");
      assert.ok(okvResult);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when okv binary is missing entirely", () => {
      const tempDir = createTempDir("okv-path-missing-");

      const results = checkPath(tempDir);
      const okvResult = results.find((r) => r.code === "PATH_OKV_MISSING");

      assert.ok(okvResult);
      assert.equal(okvResult.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("checkRules", () => {
    it("returns pass when rules match and symlinks are valid", () => {
      const tempDir = createTempDir("okv-rules-pass-");

      // Setup templates
      const templateDir = join(tempDir, ".agents", "skills", "okf-vault", "templates");
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(join(templateDir, "okv.mdc"), "rule-content", "utf8");

      // Setup rule file
      const ruleDir = join(tempDir, ".cursor", "rules");
      fs.mkdirSync(ruleDir, { recursive: true });
      fs.writeFileSync(join(ruleDir, "okv.mdc"), "rule-content", "utf8");

      // Setup IDE symlinks
      const canonicalSkill = join(tempDir, ".agents", "skills", "okf-vault");
      fs.mkdirSync(join(tempDir, ".cursor", "skills"), { recursive: true });
      fs.mkdirSync(join(tempDir, ".claude", "skills"), { recursive: true });

      fs.symlinkSync(canonicalSkill, join(tempDir, ".cursor", "skills", "okf-vault"));
      fs.symlinkSync(canonicalSkill, join(tempDir, ".claude", "skills", "okf-vault"));

      // Setup commands symlinks
      const okvCommands = [
        "okv-ingest",
        "okv-init",
        "okv-organize",
        "okv-validate",
        "okv-visualize",
        "okv-bootstrap",
        "okv-ingest-check",
      ];

      fs.mkdirSync(join(canonicalSkill, "commands"), { recursive: true });
      fs.mkdirSync(join(tempDir, ".claude", "commands"), { recursive: true });

      for (const cmd of okvCommands) {
        const cmdFile = join(canonicalSkill, "commands", `${cmd}.md`);
        fs.writeFileSync(cmdFile, "", "utf8");

        fs.mkdirSync(join(tempDir, ".cursor", "skills", cmd), { recursive: true });
        fs.symlinkSync(cmdFile, join(tempDir, ".cursor", "skills", cmd, "SKILL.md"));
        fs.symlinkSync(cmdFile, join(tempDir, ".claude", "commands", `${cmd}.md`));
      }

      const results = checkRules(tempDir);

      const issues = results.filter((r) => r.status !== "pass");
      assert.equal(issues.length, 0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail/warn when rule template is missing or outdated", () => {
      const tempDir = createTempDir("okv-rules-fail-");

      // Template missing entirely
      let results = checkRules(tempDir);
      const missingTemplate = results.find((r) => r.code === "RULES_TEMPLATE_MISSING");
      assert.ok(missingTemplate);
      assert.equal(missingTemplate.status, "warn");

      // Template exists but dest rule missing
      const templateDir = join(tempDir, ".agents", "skills", "okf-vault", "templates");
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(join(templateDir, "okv.mdc"), "rule-content", "utf8");

      results = checkRules(tempDir);
      const missingRule = results.find((r) => r.code === "RULES_MISSING");
      assert.ok(missingRule);
      assert.equal(missingRule.status, "fail");

      // Dest rule exists but is outdated
      const ruleDir = join(tempDir, ".cursor", "rules");
      fs.mkdirSync(ruleDir, { recursive: true });
      fs.writeFileSync(join(ruleDir, "okv.mdc"), "different-content", "utf8");

      results = checkRules(tempDir);
      const outdatedRule = results.find((r) => r.code === "RULES_OUTDATED");
      assert.ok(outdatedRule);
      assert.equal(outdatedRule.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when command adapters symlinks are missing or invalid", () => {
      const tempDir = createTempDir("okv-rules-sym-");

      // Template setup to avoid rule warnings
      const templateDir = join(tempDir, ".agents", "skills", "okf-vault", "templates");
      fs.mkdirSync(templateDir, { recursive: true });
      fs.writeFileSync(join(templateDir, "okv.mdc"), "rule", "utf8");
      const ruleDir = join(tempDir, ".cursor", "rules");
      fs.mkdirSync(ruleDir, { recursive: true });
      fs.writeFileSync(join(ruleDir, "okv.mdc"), "rule", "utf8");

      // Run rules check - all symlinks should be missing
      const results = checkRules(tempDir);
      const missingSymlinks = results.filter((r) => r.code === "IDE_ADAPTER_MISSING");
      assert.ok(missingSymlinks.length > 0);
      assert.equal(missingSymlinks[0]?.status, "fail");

      // Create a non-symlink file where a symlink is expected
      fs.mkdirSync(join(tempDir, ".cursor", "skills"), { recursive: true });
      fs.writeFileSync(join(tempDir, ".cursor", "skills", "okf-vault"), "not-a-symlink", "utf8");

      const results2 = checkRules(tempDir);
      const invalidSymlink = results2.find((r) => r.code === "IDE_ADAPTER_INVALID");
      assert.ok(invalidSymlink);
      assert.equal(invalidSymlink.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("checkHooks", () => {
    it("returns pass when hook has okv validate-staged", () => {
      const tempDir = createTempDir("okv-hooks-pass-");

      fs.mkdirSync(join(tempDir, ".husky"), { recursive: true });
      fs.writeFileSync(
        join(tempDir, ".husky", "pre-commit"),
        "#!/bin/sh\nnode dist/main.js validate-staged\n# okv validate-staged\n",
        "utf8",
      );

      const results = checkHooks(tempDir);
      const hooksResult = results.find((r) => r.code === "HOOKS_OK");
      assert.ok(hooksResult);
      assert.equal(hooksResult.status, "pass");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when hook is missing okv validate-staged", () => {
      const tempDir = createTempDir("okv-hooks-fail-");

      fs.mkdirSync(join(tempDir, ".husky"), { recursive: true });
      fs.writeFileSync(join(tempDir, ".husky", "pre-commit"), "#!/bin/sh\necho 'hello'\n", "utf8");

      const results = checkHooks(tempDir);
      const hooksResult = results.find((r) => r.code === "HOOKS_LACKS_OKV");
      assert.ok(hooksResult);
      assert.equal(hooksResult.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when hook is missing entirely", () => {
      const tempDir = createTempDir("okv-hooks-missing-");

      const results = checkHooks(tempDir);
      const hooksResult = results.find((r) => r.code === "HOOKS_MISSING");
      assert.ok(hooksResult);
      assert.equal(hooksResult.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("checkVault", () => {
    it("returns pass when layout and manifest match layout constraints", () => {
      const tempDir = createTempDir("okv-vault-pass-");
      const vaultRoot = join(tempDir, "knowledge");
      fs.mkdirSync(vaultRoot, { recursive: true });

      // Layout files
      fs.writeFileSync(join(vaultRoot, "index.md"), "", "utf8");
      fs.writeFileSync(join(vaultRoot, "log.md"), "", "utf8");

      fs.mkdirSync(join(vaultRoot, "notes"), { recursive: true });
      fs.writeFileSync(join(vaultRoot, "notes", "index.md"), "", "utf8");

      fs.mkdirSync(join(vaultRoot, "topics"), { recursive: true });
      fs.writeFileSync(join(vaultRoot, "topics", "index.md"), "", "utf8");

      // Manifest
      fs.mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
      const manifestData = {
        schema_version: MANIFEST_SCHEMA_VERSION,
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [
          {
            source_key: "local:notes/hello.md",
            kind: "local",
            origin: "notes/hello.md",
            content_sha256: "a".repeat(64),
            contract_version: "okf-note-contract/1.0.0",
            note_path: "notes/hello.md",
            status: "committed",
            processed_at: "2026-06-26T20:00:00Z",
          },
        ],
      };

      fs.writeFileSync(
        join(vaultRoot, ".okf-vault", "manifest.json"),
        JSON.stringify(manifestData),
        "utf8",
      );

      // Committed note
      fs.writeFileSync(join(vaultRoot, "notes", "hello.md"), "", "utf8");

      const results = checkVault(tempDir);
      const failures = results.filter((r) => r.status !== "pass");
      assert.equal(failures.length, 0);

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when vault files or manifest are missing or invalid", () => {
      const tempDir = createTempDir("okv-vault-fail-");

      // Missing vault
      let results = checkVault(tempDir);
      const missingVault = results.find((r) => r.code === "VAULT_MISSING");
      assert.ok(missingVault);
      assert.equal(missingVault.status, "fail");

      // Setup knowledge root
      const vaultRoot = join(tempDir, "knowledge");
      fs.mkdirSync(vaultRoot, { recursive: true });
      fs.mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
      fs.writeFileSync(join(vaultRoot, ".okf-vault", "manifest.json"), "invalid-json", "utf8");

      results = checkVault(tempDir);
      const missingLayout = results.filter((r) => r.code === "VAULT_LAYOUT_MISSING");
      const invalidJson = results.find((r) => r.code === "MANIFEST_INVALID");

      assert.equal(missingLayout.length, 4);
      assert.ok(invalidJson);
      assert.equal(invalidJson.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("returns fail when note path in manifest is missing from disk", () => {
      const tempDir = createTempDir("okv-vault-missing-note-");
      const vaultRoot = join(tempDir, "knowledge");
      fs.mkdirSync(vaultRoot, { recursive: true });

      // Layout files
      fs.writeFileSync(join(vaultRoot, "index.md"), "", "utf8");
      fs.writeFileSync(join(vaultRoot, "log.md"), "", "utf8");

      fs.mkdirSync(join(vaultRoot, "notes"), { recursive: true });
      fs.writeFileSync(join(vaultRoot, "notes", "index.md"), "", "utf8");

      fs.mkdirSync(join(vaultRoot, "topics"), { recursive: true });
      fs.writeFileSync(join(vaultRoot, "topics", "index.md"), "", "utf8");

      // Manifest referencing missing note
      fs.mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
      const manifestData = {
        schema_version: MANIFEST_SCHEMA_VERSION,
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [
          {
            source_key: "local:notes/missing.md",
            kind: "local",
            origin: "notes/missing.md",
            content_sha256: "a".repeat(64),
            contract_version: "okf-note-contract/1.0.0",
            note_path: "notes/missing.md",
            status: "committed",
            processed_at: "2026-06-26T20:00:00Z",
          },
        ],
      };

      fs.writeFileSync(
        join(vaultRoot, ".okf-vault", "manifest.json"),
        JSON.stringify(manifestData),
        "utf8",
      );

      const results = checkVault(tempDir);
      const noteMissing = results.find((r) => r.code === "MANIFEST_NOTE_MISSING");
      assert.ok(noteMissing);
      assert.equal(noteMissing.status, "fail");

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe("runDiagnostics", () => {
    it("aggregates check results into a DoctorReport", () => {
      const tempDir = createTempDir("okv-diag-report-");

      const report = runDiagnostics(tempDir, "/dev/null");

      assert.ok(report.checks.path);
      assert.ok(report.checks.rules);
      assert.ok(report.checks.hooks);
      assert.ok(report.checks.vault);

      assert.equal(report.checks.path.status, "fail"); // because okv is not in /dev/null

      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});
