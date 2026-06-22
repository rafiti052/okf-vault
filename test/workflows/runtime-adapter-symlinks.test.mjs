import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCommandsDir,
  cursorCommandsDir,
  claudeCommandsDir,
  cursorSkillDir,
  claudeSkillDir,
  cursorCommandSkillFile,
  claudeCommandFile,
  cursorRulePath,
  skillRoot,
  ALL_VAULT_COMMAND_STUBS,
  PIPELINE_COMMANDS,
  SHIPPED_COMMAND_STUBS,
  VAULT_COMMANDS,
  pathIsSymlink,
  resolvesToSameRealpath,
  assertAdapterStubResolves,
  hasDisableModelInvocationFrontmatter,
  frontmatterField,
  isDuplicateStubBody,
  stripYamlFrontmatter,
} from "./workflow-contract.mjs";
import { linkRuntimeAdapters } from "../../scripts/link-runtime-adapters.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const canonicalDir = canonicalCommandsDir(root);
const canonicalSkill = skillRoot(root);
const cursorDir = cursorCommandsDir(root);
const claudeDir = claudeCommandsDir(root);
const cursorSkill = cursorSkillDir(root);
const claudeSkill = claudeSkillDir(root);

describe("runtime adapter symlink helpers (unit)", () => {
  it("stripYamlFrontmatter removes YAML header", () => {
    const sample = "---\nfoo: bar\n---\n# Heading";
    assert.equal(stripYamlFrontmatter(sample), "# Heading");
  });

  it("hasDisableModelInvocationFrontmatter detects true frontmatter", () => {
    assert.equal(
      hasDisableModelInvocationFrontmatter(
        "---\ndisable-model-invocation: true\n---\n# /vault-ingest",
      ),
      true,
    );
    assert.equal(hasDisableModelInvocationFrontmatter("# no frontmatter"), false);
  });

  it("isDuplicateStubBody flags copied bodies but not frontmatter-only differences", () => {
    const body = "# /vault-ingest\n\nGuided ingest wizard.";
    const canonical = `---\ndisable-model-invocation: true\n---\n${body}`;
    const duplicate = body;
    const wrapper = `---\ndisable-model-invocation: true\n---\n# See canonical stub`;
    assert.equal(isDuplicateStubBody(duplicate, canonical), true);
    assert.equal(isDuplicateStubBody(wrapper, canonical), false);
  });

  it("resolvesToSameRealpath returns false for mismatched targets", () => {
    assert.equal(
      resolvesToSameRealpath(join(cursorDir, "vault-ingest.md"), join(root, "missing.md")),
      false,
    );
  });

  it("assertAdapterStubResolves fails for broken adapter resolution", () => {
    const result = assertAdapterStubResolves(
      cursorDir,
      join(root, "nonexistent", "commands"),
      "vault-ingest.md",
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /does not resolve|Missing canonical/);
  });
});

describe("runtime adapter symlinks (unit)", () => {
  it("Cursor skill directory is a symlink to canonical skill", () => {
    assert.ok(existsSync(cursorSkill));
    assert.equal(pathIsSymlink(cursorSkill), true);
    assert.equal(resolvesToSameRealpath(cursorSkill, canonicalSkill), true);
  });

  it("Claude skill directory is a symlink to canonical skill", () => {
    assert.ok(existsSync(claudeSkill));
    assert.equal(pathIsSymlink(claudeSkill), true);
    assert.equal(resolvesToSameRealpath(claudeSkill, canonicalSkill), true);
  });

  it("Cursor commands directory resolves to canonical commands via skill symlink", () => {
    assert.ok(existsSync(cursorDir));
    assert.equal(resolvesToSameRealpath(cursorDir, canonicalDir), true);
  });

  it("Claude commands directory resolves to canonical commands via skill symlink", () => {
    assert.ok(existsSync(claudeDir));
    assert.equal(resolvesToSameRealpath(claudeDir, canonicalDir), true);
  });

  it(".cursor/rules/okf-vault.mdc exists", () => {
    assert.ok(existsSync(cursorRulePath(root)));
  });

  it("all seven vault command stubs resolve through Cursor and Claude adapter paths", () => {
    assert.equal(ALL_VAULT_COMMAND_STUBS.length, 7);
    for (const stubFileName of ALL_VAULT_COMMAND_STUBS) {
      const cursorResult = assertAdapterStubResolves(cursorDir, canonicalDir, stubFileName);
      assert.equal(cursorResult.ok, true, cursorResult.ok ? "" : cursorResult.message);
      const claudeResult = assertAdapterStubResolves(claudeDir, canonicalDir, stubFileName);
      assert.equal(claudeResult.ok, true, claudeResult.ok ? "" : claudeResult.message);
    }
  });

  for (const stubFileName of SHIPPED_COMMAND_STUBS) {
    it(`Cursor ${stubFileName} resolves to canonical stub`, () => {
      const result = assertAdapterStubResolves(cursorDir, canonicalDir, stubFileName);
      assert.equal(result.ok, true, result.ok ? "" : result.message);
      const adapterText = readFileSync(join(cursorDir, stubFileName), "utf8");
      const canonicalText = readFileSync(join(canonicalDir, stubFileName), "utf8");
      assert.equal(stripYamlFrontmatter(adapterText), stripYamlFrontmatter(canonicalText));
    });

    it(`Claude ${stubFileName} resolves to canonical stub`, () => {
      const result = assertAdapterStubResolves(claudeDir, canonicalDir, stubFileName);
      assert.equal(result.ok, true, result.ok ? "" : result.message);
    });
  }

  it("Cursor-visible stubs for all seven commands include disable-model-invocation frontmatter", () => {
    for (const stubFileName of ALL_VAULT_COMMAND_STUBS) {
      const cursorText = readFileSync(join(cursorDir, stubFileName), "utf8");
      assert.equal(
        hasDisableModelInvocationFrontmatter(cursorText),
        true,
        `missing disable-model-invocation in ${stubFileName}`,
      );
    }
  });

  it("no duplicate full stub bodies exist under Cursor or Claude adapter trees", () => {
    for (const runtimeDir of [cursorDir, claudeDir]) {
      for (const entry of readdirSync(runtimeDir)) {
        if (!entry.endsWith(".md")) {
          continue;
        }
        const adapterPath = join(runtimeDir, entry);
        const canonicalPath = join(canonicalDir, entry);
        if (!existsSync(canonicalPath)) {
          continue;
        }
        if (resolvesToSameRealpath(adapterPath, canonicalPath)) {
          continue;
        }
        const adapterText = readFileSync(adapterPath, "utf8");
        const canonicalText = readFileSync(canonicalPath, "utf8");
        assert.equal(
          isDuplicateStubBody(adapterText, canonicalText),
          false,
          `duplicate body at ${adapterPath}`,
        );
      }
    }
  });

  it("adapter trees expose all shipped command stubs including pipeline stubs", () => {
    const cursorEntries = readdirSync(cursorDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    assert.deepEqual(cursorEntries, [...SHIPPED_COMMAND_STUBS].sort());
    const claudeEntries = readdirSync(claudeDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    assert.deepEqual(claudeEntries, [...SHIPPED_COMMAND_STUBS].sort());
  });
});

describe("per-command discoverable units (unit)", () => {
  it("exposes 14 per-command discoverable units (7 Cursor skills + 7 Claude commands)", () => {
    assert.equal(VAULT_COMMANDS.length, 7);
    let count = 0;
    for (const command of VAULT_COMMANDS) {
      assert.ok(existsSync(cursorCommandSkillFile(root, command)));
      assert.ok(existsSync(claudeCommandFile(root, command)));
      count += 2;
    }
    assert.equal(count, 14);
  });

  for (const command of VAULT_COMMANDS) {
    const canonicalStub = join(canonicalDir, `${command}.md`);

    it(`Cursor .cursor/skills/${command}/SKILL.md resolves to canonical stub`, () => {
      const skillFile = cursorCommandSkillFile(root, command);
      assert.ok(existsSync(skillFile), `missing ${skillFile}`);
      assert.equal(pathIsSymlink(skillFile), true);
      assert.equal(resolvesToSameRealpath(skillFile, canonicalStub), true);
    });

    it(`Cursor /${command} SKILL.md carries name matching its folder and disable-model-invocation`, () => {
      const skillFile = cursorCommandSkillFile(root, command);
      const text = readFileSync(skillFile, "utf8");
      const folderName = dirname(skillFile).split("/").pop();
      assert.equal(folderName, command);
      assert.equal(
        frontmatterField(text, "name"),
        command,
        `name frontmatter must equal folder ${command}`,
      );
      assert.equal(
        hasDisableModelInvocationFrontmatter(text),
        true,
        `missing disable-model-invocation in ${command}`,
      );
    });

    it(`Claude .claude/commands/${command}.md resolves to canonical stub`, () => {
      const claudeFile = claudeCommandFile(root, command);
      assert.ok(existsSync(claudeFile), `missing ${claudeFile}`);
      assert.equal(pathIsSymlink(claudeFile), true);
      assert.equal(resolvesToSameRealpath(claudeFile, canonicalStub), true);
    });
  }
});

describe("foreign-repo init (integration)", () => {
  const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-foreign-"));

  after(() => {
    rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it("linkRuntimeAdapters against a foreign --project-root resolves all 14 per-command links into the clone", () => {
    const result = linkRuntimeAdapters({
      projectRoot: tempProjectRoot,
      canonicalSkillRoot: canonicalSkill,
      quiet: true,
    });
    assert.ok(result.linked.length + result.skipped.length >= 16);

    for (const command of VAULT_COMMANDS) {
      const canonicalStub = join(canonicalDir, `${command}.md`);

      const cursorSkillFile = cursorCommandSkillFile(tempProjectRoot, command);
      assert.ok(existsSync(cursorSkillFile), `missing ${cursorSkillFile}`);
      assert.equal(pathIsSymlink(cursorSkillFile), true);
      assert.equal(resolvesToSameRealpath(cursorSkillFile, canonicalStub), true);

      const claudeFile = claudeCommandFile(tempProjectRoot, command);
      assert.ok(existsSync(claudeFile), `missing ${claudeFile}`);
      assert.equal(pathIsSymlink(claudeFile), true);
      assert.equal(resolvesToSameRealpath(claudeFile, canonicalStub), true);
    }
  });

  it("foreign-repo umbrella skill symlinks resolve to the canonical skill", () => {
    assert.equal(resolvesToSameRealpath(cursorSkillDir(tempProjectRoot), canonicalSkill), true);
    assert.equal(resolvesToSameRealpath(claudeSkillDir(tempProjectRoot), canonicalSkill), true);
  });

  it("foreign-repo re-run is idempotent (all links skipped on second pass)", () => {
    const second = linkRuntimeAdapters({
      projectRoot: tempProjectRoot,
      canonicalSkillRoot: canonicalSkill,
      quiet: true,
    });
    assert.equal(second.linked.length, 0);
    assert.equal(second.skipped.length, 16);
  });
});

describe("runtime adapter symlinks (integration)", () => {
  it("registry.md is reachable through both runtime adapter paths", () => {
    for (const runtimeDir of [cursorDir, claudeDir]) {
      const registryPath = join(runtimeDir, "registry.md");
      assert.ok(existsSync(registryPath));
      assert.equal(resolvesToSameRealpath(registryPath, join(canonicalDir, "registry.md")), true);
      assert.match(readFileSync(registryPath, "utf8"), /MVP shipped/);
    }
  });

  it("broken symlink detection fails when canonical stub path is wrong", () => {
    const broken = assertAdapterStubResolves(
      cursorDir,
      join(root, "renamed-stub-tree"),
      "vault-ingest.md",
    );
    assert.equal(broken.ok, false);
    assert.match(broken.message, /Missing canonical|does not resolve/);
  });

  it("all seven /vault-* slash entries are discoverable at expected runtime paths", () => {
    for (const command of VAULT_COMMANDS) {
      const stubFileName = `${command}.md`;
      for (const runtimeDir of [cursorDir, claudeDir]) {
        const stubPath = join(runtimeDir, stubFileName);
        assert.ok(existsSync(stubPath), `missing ${stubPath}`);
        const heading = readFileSync(stubPath, "utf8")
          .split("\n")
          .find((line) => line.startsWith("#"));
        assert.match(heading ?? "", new RegExp(`/${command}`));
      }
    }
  });

  it("Cursor pipeline command stubs include disable-model-invocation frontmatter", () => {
    for (const command of PIPELINE_COMMANDS) {
      const stubPath = join(cursorDir, `${command}.md`);
      const stubText = readFileSync(stubPath, "utf8");
      assert.equal(
        hasDisableModelInvocationFrontmatter(stubText),
        true,
        `missing disable-model-invocation in ${command}.md`,
      );
    }
  });
});
