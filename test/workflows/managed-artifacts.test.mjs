import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import {
  LEGACY_VAULT_COMMANDS,
  OKV_COMMANDS,
  listLegacyArtifacts,
  listManagedArtifacts,
} from "../../scripts/managed-artifacts.mjs";
import { claudeCommandFile, cursorCommandSkillFile } from "./workflow-contract.mjs";

const tempRoots = [];

function createProjectRoot() {
  const root = mkdtempSync(join(tmpdir(), "okv-managed-artifacts-"));
  tempRoots.push(root);
  return root;
}

function localArtifacts(artifacts) {
  return artifacts.filter((artifact) => artifact.kind !== "global-bin");
}

function globalBins(artifacts) {
  return artifacts.filter((artifact) => artifact.kind === "global-bin");
}

function artifactKey(artifact) {
  if (artifact.kind === "global-bin") {
    return `global-bin:${artifact.name}`;
  }
  return `${artifact.kind}:${artifact.path}`;
}

after(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("managed artifact manifest (unit)", () => {
  it("enumerates current repo-local artifacts and global binaries", () => {
    const projectRoot = createProjectRoot();
    const artifacts = listManagedArtifacts(projectRoot);
    const locals = localArtifacts(artifacts);
    const bins = globalBins(artifacts);

    assert.equal(locals.length, 19);
    assert.ok(locals.length >= 18);
    assert.equal(bins.length, 2);
    assert.deepEqual(bins.map((artifact) => artifact.name).sort(), ["okf-vault", "okv"]);
    assert.ok(bins.find((artifact) => artifact.name === "okf-vault")?.tombstone);

    for (const artifact of artifacts) {
      assert.match(artifact.kind, /^(symlink|file-copy|global-bin)$/);
      assert.equal(typeof artifact.label, "string");
      assert.notEqual(artifact.label.length, 0);
      if (artifact.kind === "global-bin") {
        assert.equal(typeof artifact.name, "string");
        assert.equal("path" in artifact, false);
      } else {
        assert.equal(artifact.path.startsWith(resolve(projectRoot)), true);
      }
    }
  });

  it("points managed symlinks at the post-rebrand canonical skill tree", () => {
    const projectRoot = createProjectRoot();
    const canonicalSegment = join(".agents", "skills", "okf-vault");
    const symlinks = listManagedArtifacts(projectRoot).filter(
      (artifact) => artifact.kind === "symlink",
    );

    assert.equal(symlinks.length, 18);
    for (const artifact of symlinks) {
      assert.equal(typeof artifact.target, "string");
      assert.ok(
        artifact.target.includes(canonicalSegment),
        `${artifact.label} target should include ${canonicalSegment}`,
      );
    }
  });

  it("includes all eight okv commands in Cursor and Claude entries", () => {
    const projectRoot = createProjectRoot();
    const artifacts = listManagedArtifacts(projectRoot);

    assert.equal(OKV_COMMANDS.length, 8);
    for (const command of OKV_COMMANDS) {
      assert.ok(
        artifacts.some(
          (artifact) =>
            artifact.kind === "symlink" &&
            artifact.path === join(resolve(projectRoot), ".cursor", "skills", command, "SKILL.md"),
        ),
        `missing Cursor artifact for ${command}`,
      );
      assert.ok(
        artifacts.some(
          (artifact) =>
            artifact.kind === "symlink" &&
            artifact.path === join(resolve(projectRoot), ".claude", "commands", `${command}.md`),
        ),
        `missing Claude artifact for ${command}`,
      );
    }
  });

  it("enumerates legacy skill paths, vault stubs, curator rule, and global binary", () => {
    const projectRoot = createProjectRoot();
    const artifacts = listLegacyArtifacts(projectRoot);

    assert.ok(
      artifacts.some(
        (artifact) =>
          artifact.path === join(resolve(projectRoot), ".agents", "skills", "okf-knowledge-vault"),
      ),
    );
    assert.ok(
      artifacts.some(
        (artifact) =>
          artifact.path === join(resolve(projectRoot), ".cursor", "skills", "okf-knowledge-vault"),
      ),
    );
    assert.ok(
      artifacts.some(
        (artifact) =>
          artifact.path === join(resolve(projectRoot), ".claude", "skills", "okf-knowledge-vault"),
      ),
    );
    assert.ok(
      artifacts.some(
        (artifact) =>
          artifact.kind === "file-copy" &&
          artifact.path === join(resolve(projectRoot), ".cursor", "rules", "okf-vault.mdc"),
      ),
    );
    assert.ok(
      artifacts.some((artifact) => artifact.kind === "global-bin" && artifact.name === "okf-vault"),
    );

    assert.equal(LEGACY_VAULT_COMMANDS.length, 7);
    for (const command of LEGACY_VAULT_COMMANDS) {
      assert.ok(
        artifacts.some(
          (artifact) =>
            artifact.path === join(resolve(projectRoot), ".cursor", "skills", command, "SKILL.md"),
        ),
        `missing legacy Cursor artifact for ${command}`,
      );
      assert.ok(
        artifacts.some(
          (artifact) =>
            artifact.path === join(resolve(projectRoot), ".claude", "commands", `${command}.md`),
        ),
        `missing legacy Claude artifact for ${command}`,
      );
    }
  });

  it("sets legacy flags only on legacy artifacts", () => {
    const projectRoot = createProjectRoot();

    for (const artifact of listManagedArtifacts(projectRoot)) {
      assert.equal(artifact.legacy, undefined, `${artifact.label} should not be legacy`);
    }
    for (const artifact of listLegacyArtifacts(projectRoot)) {
      assert.equal(artifact.legacy, true, `${artifact.label} should be legacy`);
    }
  });

  it("does not write to the filesystem while listing artifacts", () => {
    const projectRoot = createProjectRoot();
    assert.deepEqual(readdirSync(projectRoot), []);

    listManagedArtifacts(projectRoot);
    listLegacyArtifacts(projectRoot);

    assert.deepEqual(readdirSync(projectRoot), []);
  });
});

describe("managed artifact manifest (integration)", () => {
  it("matches workflow-contract path helpers for okv command stubs", () => {
    const projectRoot = createProjectRoot();
    const artifacts = listManagedArtifacts(projectRoot);

    for (const command of OKV_COMMANDS) {
      assert.ok(
        artifacts.some(
          (artifact) => artifact.path === cursorCommandSkillFile(projectRoot, command),
        ),
        `manifest should match Cursor helper for ${command}`,
      );
      assert.ok(
        artifacts.some((artifact) => artifact.path === claudeCommandFile(projectRoot, command)),
        `manifest should match Claude helper for ${command}`,
      );
    }
  });

  it("keeps legacy artifacts disjoint from managed artifacts except the tombstone bin", () => {
    const projectRoot = createProjectRoot();
    const managedKeys = new Set(listManagedArtifacts(projectRoot).map(artifactKey));
    const overlaps = listLegacyArtifacts(projectRoot)
      .map(artifactKey)
      .filter((key) => managedKeys.has(key));

    assert.deepEqual(overlaps, ["global-bin:okf-vault"]);
  });
});
