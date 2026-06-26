import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, it } from "node:test";
import type { DoctorReport } from "../../dist/vault/diagnostics.js";
import {
  createReadlinePrompter,
  repairCursorRules,
  repairLegacyGlobalConflicts,
  repairPreCommitHook,
  runDoctorRepairWizard,
} from "../../dist/vault/doctor-repair.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function seedRuleTemplate(projectRoot: string, content = "rule-content\n"): string {
  const template = join(projectRoot, ".agents", "skills", "okf-vault", "templates", "okv.mdc");
  mkdirSync(dirname(template), { recursive: true });
  writeFileSync(template, content, "utf8");
  return template;
}

describe("doctor repair wizard", () => {
  it("reads yes/no confirmation with the built-in readline prompter", async () => {
    const output = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });
    const yesPrompter = createReadlinePrompter({
      input: Readable.from(["yes\n"]),
      output,
    });
    const noPrompter = createReadlinePrompter({
      input: Readable.from(["no\n"]),
      output,
    });

    assert.equal(await yesPrompter("continue? "), true);
    assert.equal(await noPrompter("continue? "), false);
  });

  it("repairs rule template when confirmed", async () => {
    const projectRoot = tempRoot("okv-repair-rules-yes-");
    seedRuleTemplate(projectRoot, "expected-rule\n");
    const dest = join(projectRoot, ".cursor", "rules", "okv.mdc");

    const result = await repairCursorRules(projectRoot, { prompter: () => true });

    assert.equal(result.applied.length, 1);
    assert.equal(result.applied[0]?.code, "RULES_REPAIRED");
    assert.equal(readFileSync(dest, "utf8"), "expected-rule\n");

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("reports a missing source template instead of creating a rule", async () => {
    const projectRoot = tempRoot("okv-repair-rules-missing-template-");

    const result = await repairCursorRules(projectRoot, { prompter: () => true });

    assert.equal(result.errors[0]?.code, "RULES_TEMPLATE_MISSING");

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("leaves rule template untouched when declined", async () => {
    const projectRoot = tempRoot("okv-repair-rules-no-");
    seedRuleTemplate(projectRoot, "expected-rule\n");
    const dest = join(projectRoot, ".cursor", "rules", "okv.mdc");

    const result = await repairCursorRules(projectRoot, { prompter: () => false });

    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.code, "RULES_REPAIR_DECLINED");
    assert.equal(existsSync(dest), false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("discovers legacy global conflicts from PATH directories", async () => {
    const projectRoot = tempRoot("okv-repair-legacy-path-");
    const bin = join(projectRoot, "bin");
    mkdirSync(bin, { recursive: true });
    const legacy = join(bin, "okv-cli");
    writeFileSync(legacy, "#!/bin/sh\n", "utf8");

    const result = await repairLegacyGlobalConflicts({
      envPath: bin,
      prompter: () => true,
    });

    assert.equal(result.applied[0]?.path, legacy);
    assert.equal(existsSync(legacy), false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("removes legacy global naming conflicts when confirmed", async () => {
    const projectRoot = tempRoot("okv-repair-legacy-yes-");
    const okfVault = join(projectRoot, "okf-vault");
    const okvCli = join(projectRoot, "okv-cli");
    writeFileSync(okfVault, "#!/bin/sh\n", "utf8");
    writeFileSync(okvCli, "#!/bin/sh\n", "utf8");

    const result = await repairLegacyGlobalConflicts({
      paths: [okfVault, okvCli],
      prompter: () => true,
    });

    assert.equal(result.applied.length, 2);
    assert.equal(existsSync(okfVault), false);
    assert.equal(existsSync(okvCli), false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("keeps legacy global naming conflicts when declined", async () => {
    const projectRoot = tempRoot("okv-repair-legacy-no-");
    const legacy = join(projectRoot, "okf-vault");
    writeFileSync(legacy, "#!/bin/sh\n", "utf8");

    const result = await repairLegacyGlobalConflicts({
      paths: [legacy],
      prompter: () => false,
    });

    assert.equal(result.skipped.length, 1);
    assert.equal(result.skipped[0]?.code, "PATH_LEGACY_CONFLICT");
    assert.equal(existsSync(legacy), true);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("chains git hook by appending validator to an existing pre-commit hook", async () => {
    const projectRoot = tempRoot("okv-repair-hook-append-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\necho custom\n", "utf8");

    const result = await repairPreCommitHook(projectRoot, { prompter: () => true });
    const content = readFileSync(hook, "utf8");

    assert.equal(result.applied[0]?.code, "HOOKS_CHAINED");
    assert.match(content, /echo custom/);
    assert.match(content, /okv validate-staged/);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("chains husky hook before falling back to .git hook when husky exists", async () => {
    const projectRoot = tempRoot("okv-repair-hook-husky-");
    const huskyHook = join(projectRoot, ".husky", "pre-commit");
    const gitHook = join(projectRoot, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(huskyHook), { recursive: true });
    mkdirSync(dirname(gitHook), { recursive: true });
    writeFileSync(huskyHook, "#!/bin/sh\necho husky\n", "utf8");
    writeFileSync(gitHook, "#!/bin/sh\necho git\n", "utf8");

    const result = await repairPreCommitHook(projectRoot, { prompter: () => true });

    assert.equal(result.applied[0]?.path, huskyHook);
    assert.match(readFileSync(huskyHook, "utf8"), /okv validate-staged/);
    assert.doesNotMatch(readFileSync(gitHook, "utf8"), /okv validate-staged/);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("creates a new executable pre-commit hook when none exists", async () => {
    const projectRoot = tempRoot("okv-repair-hook-create-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");

    const result = await repairPreCommitHook(projectRoot, { prompter: () => true });
    const content = readFileSync(hook, "utf8");
    const mode = statSync(hook).mode & 0o777;

    assert.equal(result.applied[0]?.code, "HOOKS_CREATED");
    assert.match(content, /^#!\/bin\/sh/);
    assert.match(content, /okv validate-staged/);
    assert.equal(mode & 0o111, 0o111);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("detects existing hook checks and skips duplicate insertion", async () => {
    const projectRoot = tempRoot("okv-repair-hook-duplicate-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");
    mkdirSync(dirname(hook), { recursive: true });
    writeFileSync(hook, "#!/bin/sh\nokv validate-staged\n", "utf8");
    chmodSync(hook, 0o755);

    const result = await repairPreCommitHook(projectRoot, { prompter: () => true });
    const content = readFileSync(hook, "utf8");

    assert.equal(result.skipped[0]?.code, "HOOKS_ALREADY_CHAINED");
    assert.equal(content.match(/okv validate-staged/g)?.length, 1);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("does not create a hook when hook repair is declined", async () => {
    const projectRoot = tempRoot("okv-repair-hook-no-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");

    const result = await repairPreCommitHook(projectRoot, { prompter: () => false });

    assert.equal(result.skipped[0]?.code, "HOOKS_REPAIR_DECLINED");
    assert.equal(existsSync(hook), false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("defaults to skipping repairs in non-interactive mode without an injected prompter", async () => {
    const projectRoot = tempRoot("okv-repair-headless-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");

    const result = await repairPreCommitHook(projectRoot, {
      stdout: { isTTY: false },
      env: {},
    });

    assert.equal(result.skipped[0]?.code, "HOOKS_REPAIR_DECLINED");
    assert.equal(existsSync(hook), false);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("uses readline prompts for interactive repairs when no mock prompter is injected", async () => {
    const projectRoot = tempRoot("okv-repair-readline-hook-");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");
    const output = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });

    const result = await repairPreCommitHook(projectRoot, {
      input: Readable.from(["yes\n"]),
      output,
      stdout: { isTTY: true },
      env: {},
    });

    assert.equal(result.applied[0]?.code, "HOOKS_CREATED");
    assert.match(readFileSync(hook, "utf8"), /okv validate-staged/);

    rmSync(projectRoot, { recursive: true, force: true });
  });

  it("runs aggregate wizard repairs for diagnostic report issues", async () => {
    const projectRoot = tempRoot("okv-repair-wizard-");
    seedRuleTemplate(projectRoot, "expected-rule\n");
    const legacy = join(projectRoot, "okf-vault");
    const hook = join(projectRoot, ".git", "hooks", "pre-commit");
    writeFileSync(legacy, "#!/bin/sh\n", "utf8");
    const report: DoctorReport = {
      checks: {
        path: {
          status: "fail",
          summary: "path",
          issues: [
            {
              code: "PATH_LEGACY_CONFLICT",
              status: "fail",
              message: "legacy",
              path: legacy,
            },
          ],
        },
        rules: {
          status: "fail",
          summary: "rules",
          issues: [{ code: "RULES_MISSING", status: "fail", message: "rules" }],
        },
        hooks: {
          status: "fail",
          summary: "hooks",
          issues: [{ code: "HOOKS_MISSING", status: "fail", message: "hooks" }],
        },
      },
    };

    const result = await runDoctorRepairWizard(projectRoot, report, { prompter: () => true });

    assert.equal(result.errors.length, 0);
    assert.equal(result.applied.length, 3);
    assert.equal(existsSync(legacy), false);
    assert.equal(
      readFileSync(join(projectRoot, ".cursor", "rules", "okv.mdc"), "utf8"),
      "expected-rule\n",
    );
    assert.match(readFileSync(hook, "utf8"), /okv validate-staged/);

    rmSync(projectRoot, { recursive: true, force: true });
  });
});
