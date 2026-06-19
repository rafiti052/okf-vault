import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCommandsDir,
  cursorCommandsDir,
  claudeCommandsDir,
  MVP_COMMAND_STUBS,
  pathIsSymlink,
  resolvesToSameRealpath,
  assertAdapterStubResolves,
  hasDisableModelInvocationFrontmatter,
  isDuplicateStubBody,
  stripYamlFrontmatter,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const canonicalDir = canonicalCommandsDir(root);
const cursorDir = cursorCommandsDir(root);
const claudeDir = claudeCommandsDir(root);

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
  it("Cursor commands directory is a symlink to canonical commands", () => {
    assert.ok(existsSync(cursorDir));
    assert.equal(pathIsSymlink(cursorDir), true);
    assert.equal(resolvesToSameRealpath(cursorDir, canonicalDir), true);
  });

  it("Claude commands directory resolves to canonical commands via skill symlink", () => {
    assert.ok(existsSync(claudeDir));
    assert.equal(resolvesToSameRealpath(claudeDir, canonicalDir), true);
  });

  for (const stubFileName of MVP_COMMAND_STUBS) {
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

  it("Cursor-visible vault-ingest includes disable-model-invocation frontmatter", () => {
    const cursorIngestText = readFileSync(join(cursorDir, "vault-ingest.md"), "utf8");
    assert.equal(hasDisableModelInvocationFrontmatter(cursorIngestText), true);
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

  it("MVP adapter trees expose only vault-ingest and registry stubs", () => {
    const cursorEntries = readdirSync(cursorDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    assert.deepEqual(cursorEntries, [...MVP_COMMAND_STUBS].sort());
    const claudeEntries = readdirSync(claudeDir)
      .filter((entry) => entry.endsWith(".md"))
      .sort();
    assert.deepEqual(claudeEntries, [...MVP_COMMAND_STUBS].sort());
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

  it("vault-ingest slash entry is discoverable at expected runtime paths", () => {
    for (const runtimeDir of [cursorDir, claudeDir]) {
      const ingestPath = join(runtimeDir, "vault-ingest.md");
      assert.ok(existsSync(ingestPath));
      const heading = readFileSync(ingestPath, "utf8")
        .split("\n")
        .find((line) => line.startsWith("#"));
      assert.match(heading ?? "", /\/vault-ingest/);
    }
  });
});
