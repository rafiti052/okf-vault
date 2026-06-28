import {
  readFileSync,
  existsSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  readlinkSync,
  lstatSync,
} from "node:fs";
import { dirname, join, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
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
  skillRoot,
  ALL_OKV_COMMAND_STUBS,
  PIPELINE_COMMANDS,
  SHIPPED_COMMAND_STUBS,
  OKV_COMMANDS as HARNESS_OKV_COMMANDS,
  pathIsSymlink,
  resolvesToSameRealpath,
  assertAdapterStubResolves,
  hasDisableModelInvocationFrontmatter,
  isDuplicateStubBody,
  stripYamlFrontmatter,
  verifyRuntimeAdapters,
} from "./workflow-contract.mjs";
import {
  ensureSymlink,
  linkRuntimeAdapters,
  OKV_COMMANDS,
  sweepLegacyArtifacts,
} from "../../scripts/link-runtime-adapters.mjs";
import { listLegacyArtifacts, listManagedArtifacts } from "../../scripts/managed-artifacts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const canonicalDir = canonicalCommandsDir(root);
const canonicalSkill = skillRoot(root);
const cursorDir = cursorCommandsDir(root);
const claudeDir = claudeCommandsDir(root);
const cursorSkill = cursorSkillDir(root);
const claudeSkill = claudeSkillDir(root);

function existsOrSymlink(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function seedLegacyStubs(projectRoot) {
  const cursorStub = join(projectRoot, ".cursor", "skills", "vault-ingest", "SKILL.md");
  mkdirSync(dirname(cursorStub), { recursive: true });
  writeFileSync(cursorStub, "# /vault-ingest\n", "utf8");

  const claudeBroken = join(projectRoot, ".claude", "commands", "vault-init.md");
  mkdirSync(dirname(claudeBroken), { recursive: true });
  symlinkSync(join(projectRoot, "missing", "vault-init.md"), claudeBroken);

  const legacyUmbrella = join(projectRoot, ".cursor", "skills", "okf-knowledge-vault");
  symlinkSync(join(projectRoot, "missing", "okf-knowledge-vault"), legacyUmbrella);
}

function assertNoLegacyArtifacts(projectRoot) {
  for (const artifact of listLegacyArtifacts(projectRoot)) {
    if (artifact.path !== undefined) {
      assert.equal(
        existsOrSymlink(artifact.path),
        false,
        `legacy artifact remains: ${artifact.path}`,
      );
    }
  }
}

function countManagedSymlinks(projectRoot) {
  return listManagedArtifacts(projectRoot).filter((artifact) => artifact.kind === "symlink").length;
}

describe("runtime adapter symlink helpers (unit)", () => {
  it("stripYamlFrontmatter removes YAML header", () => {
    const sample = "---\nfoo: bar\n---\n# Heading";
    assert.equal(stripYamlFrontmatter(sample), "# Heading");
  });

  it("hasDisableModelInvocationFrontmatter detects true frontmatter", () => {
    assert.equal(
      hasDisableModelInvocationFrontmatter(
        "---\ndisable-model-invocation: true\n---\n# /okv-ingest",
      ),
      true,
    );
    assert.equal(hasDisableModelInvocationFrontmatter("# no frontmatter"), false);
  });

  it("isDuplicateStubBody flags copied bodies but not frontmatter-only differences", () => {
    const body = "# /okv-ingest\n\nGuided ingest wizard.";
    const canonical = `---\ndisable-model-invocation: true\n---\n${body}`;
    const duplicate = body;
    const wrapper = `---\ndisable-model-invocation: true\n---\n# See canonical stub`;
    assert.equal(isDuplicateStubBody(duplicate, canonical), true);
    assert.equal(isDuplicateStubBody(wrapper, canonical), false);
  });

  it("resolvesToSameRealpath returns false for mismatched targets", () => {
    assert.equal(
      resolvesToSameRealpath(join(cursorDir, "okv-ingest.md"), join(root, "missing.md")),
      false,
    );
  });

  it("assertAdapterStubResolves fails for broken adapter resolution", () => {
    const result = assertAdapterStubResolves(
      cursorDir,
      join(root, "nonexistent", "commands"),
      "okv-ingest.md",
    );
    assert.equal(result.ok, false);
    assert.match(result.message, /does not resolve|Missing canonical/);
  });
});

describe("legacy sweep helpers (unit)", () => {
  it("sweepLegacyArtifacts removes Cursor vault-ingest stub and reports it", () => {
    const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-sweep-"));
    try {
      seedLegacyStubs(tempProjectRoot);
      const cursorStub = join(tempProjectRoot, ".cursor", "skills", "vault-ingest", "SKILL.md");

      const result = sweepLegacyArtifacts(tempProjectRoot);

      assert.equal(existsOrSymlink(cursorStub), false);
      assert.equal(existsOrSymlink(dirname(cursorStub)), false);
      assert.ok(result.removed.includes(cursorStub));
      assert.ok(
        result.removed.some((path) => path.endsWith(join(".claude", "commands", "vault-init.md"))),
      );
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it("sweepLegacyArtifacts is idempotent on a clean tree", () => {
    const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-sweep-clean-"));
    try {
      const first = sweepLegacyArtifacts(tempProjectRoot);
      const second = sweepLegacyArtifacts(tempProjectRoot);
      assert.deepEqual(first.removed, []);
      assert.deepEqual(second.removed, []);
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it("ensureSymlink skips a valid existing link on idempotent re-run", () => {
    const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-link-"));
    try {
      const canonicalPath = join(tempProjectRoot, "canonical.md");
      const linkPath = join(tempProjectRoot, "adapter", "SKILL.md");
      writeFileSync(canonicalPath, "# canonical\n", "utf8");
      const first = { linked: [], skipped: [] };
      ensureSymlink({
        linkPath,
        canonicalPath,
        label: "test adapter",
        projectRoot: tempProjectRoot,
        quiet: true,
        linked: first.linked,
        skipped: first.skipped,
      });
      const second = { linked: [], skipped: [] };
      ensureSymlink({
        linkPath,
        canonicalPath,
        label: "test adapter",
        projectRoot: tempProjectRoot,
        quiet: true,
        linked: second.linked,
        skipped: second.skipped,
      });

      assert.deepEqual(first.linked, [linkPath]);
      assert.deepEqual(second.linked, []);
      assert.deepEqual(second.skipped, [linkPath]);
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
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

  it("legacy runtime artifacts are absent from the repository adapter trees", () => {
    assertNoLegacyArtifacts(root);
    assert.equal(existsSync(join(root, ".cursor", "rules", "okf-vault.mdc")), false);
  });

  it("all eight OKV command stubs resolve through Cursor and Claude adapter paths", () => {
    assert.equal(ALL_OKV_COMMAND_STUBS.length, 8);
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
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
    for (const stubFileName of ALL_OKV_COMMAND_STUBS) {
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

describe("per-command discoverable unit contract (unit)", () => {
  it("exports exactly eight OKV command slugs for adapter scripts", () => {
    assert.deepEqual(OKV_COMMANDS, HARNESS_OKV_COMMANDS);
    assert.equal(OKV_COMMANDS.length, 8);
    for (const command of OKV_COMMANDS) {
      assert.match(command, /^okv-/);
    }
  });
});

describe("foreign-repo init (integration)", () => {
  const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-foreign-"));

  after(() => {
    rmSync(tempProjectRoot, { recursive: true, force: true });
  });

  it("linkRuntimeAdapters against a foreign --project-root resolves all 16 per-command links into the clone", () => {
    const result = linkRuntimeAdapters({
      projectRoot: tempProjectRoot,
      canonicalSkillRoot: canonicalSkill,
      quiet: true,
    });
    assert.equal(result.linked.length + result.skipped.length, 18);
    assert.equal(countManagedSymlinks(tempProjectRoot), 18);
    const verification = verifyRuntimeAdapters(tempProjectRoot, {
      canonicalSkillRoot: canonicalSkill,
    });
    assert.equal(verification.ok, true, verification.ok ? "" : verification.message);

    for (const command of HARNESS_OKV_COMMANDS) {
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
    assert.equal(isAbsolute(readlinkSync(cursorSkillDir(tempProjectRoot))), true);
  });

  it("foreign-repo re-run is idempotent (all links skipped on second pass)", () => {
    const second = linkRuntimeAdapters({
      projectRoot: tempProjectRoot,
      canonicalSkillRoot: canonicalSkill,
      quiet: true,
    });
    assert.equal(second.linked.length, 0);
    assert.equal(second.skipped.length, 18);
  });
});

describe("setup adapter installation (integration)", () => {
  it("link-runtime-adapters CLI keeps JSON stdout clean while verbose sweep logs to stderr", () => {
    const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-link-cli-"));
    try {
      seedLegacyStubs(tempProjectRoot);
      const result = spawnSync(
        process.execPath,
        [
          join(root, "scripts", "link-runtime-adapters.mjs"),
          "--json",
          "--project-root",
          tempProjectRoot,
          "--canonical-skill-root",
          canonicalSkill,
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OKV_VERBOSE: "1" },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /removed legacy artifact:/);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "ok");
      assert.equal(payload.command, "link-runtime-adapters");
      assert.equal(payload.data.linked.length, 18);
      assert.ok(
        payload.data.removed.some((path) =>
          path.endsWith(join(".cursor", "skills", "vault-ingest", "SKILL.md")),
        ),
      );
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  it("install.mjs dry invocation reports removed legacy paths and verifies adapters", () => {
    const tempProjectRoot = mkdtempSync(join(tmpdir(), "okf-vault-setup-"));
    try {
      seedLegacyStubs(tempProjectRoot);
      const result = spawnSync(
        process.execPath,
        [
          join(root, "scripts", "install.mjs"),
          "--dry-run",
          "--json",
          "--project-root",
          tempProjectRoot,
          "--canonical-skill-root",
          canonicalSkill,
        ],
        { encoding: "utf8" },
      );

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "ok");
      assert.equal(payload.command, "setup");
      assert.equal(payload.data.adapters_verified, true);
      assert.equal(payload.data.linked.length, 18);
      assert.ok(
        payload.data.removed.some((path) =>
          path.endsWith(join(".cursor", "skills", "vault-ingest", "SKILL.md")),
        ),
      );
      assertNoLegacyArtifacts(tempProjectRoot);
    } finally {
      rmSync(tempProjectRoot, { recursive: true, force: true });
    }
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
      "okv-ingest.md",
    );
    assert.equal(broken.ok, false);
    assert.match(broken.message, /Missing canonical|does not resolve/);
  });

  it("all seven /okv-* slash entries are discoverable at expected runtime paths", () => {
    for (const command of HARNESS_OKV_COMMANDS) {
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
