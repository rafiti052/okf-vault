import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode, dispatch, parseArgs } from "../../dist/cli.js";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  buildVaultLinkGraph,
  extractLinkTargets,
  resolveLinkTarget,
  validateVaultGraph,
} from "../../dist/vault/graph.js";
import { saveManifest, type Manifest, type SourceRecord } from "../../dist/vault/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const navigationFixtures = join(root, "test", "fixtures", "vaults", "navigation");
const VALID_SHA = "a".repeat(64);
const VALID_SHA_B = "b".repeat(64);
const VALID_SHA_C = "c".repeat(64);
const VALID_SHA_D = "d".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function committedRecord(notePath: string, sourceKey: string, sha = VALID_SHA): SourceRecord {
  return {
    source_key: sourceKey,
    kind: "local",
    origin: `/fixtures/${notePath}`,
    content_sha256: sha,
    contract_version: NOTE_CONTRACT_VERSION,
    note_path: notePath,
    status: "committed",
    commit: "abc1234",
    processed_at: VALID_TS,
  };
}

function skippedRecord(notePath: string, sourceKey: string): SourceRecord {
  return {
    source_key: sourceKey,
    kind: "local",
    origin: `/fixtures/${notePath}`,
    content_sha256: VALID_SHA_C,
    contract_version: NOTE_CONTRACT_VERSION,
    note_path: notePath,
    status: "skipped",
    skip_reason: "fixture skip",
    processed_at: VALID_TS,
  };
}

function writeMinimalVault(
  vaultRoot: string,
  options: {
    rootIndex: string;
    notesIndex: string;
    topicsIndex: string;
    notes: Record<string, string>;
    topics?: Record<string, string>;
    sources: SourceRecord[];
  },
): void {
  mkdirSync(join(vaultRoot, "notes"), { recursive: true });
  mkdirSync(join(vaultRoot, "topics"), { recursive: true });
  mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });

  writeFileSync(join(vaultRoot, "index.md"), options.rootIndex, "utf8");
  writeFileSync(join(vaultRoot, "log.md"), "# Change Log\n", "utf8");
  writeFileSync(join(vaultRoot, "notes/index.md"), options.notesIndex, "utf8");
  writeFileSync(join(vaultRoot, "topics/index.md"), options.topicsIndex, "utf8");

  for (const [relativePath, content] of Object.entries(options.notes)) {
    writeFileSync(join(vaultRoot, relativePath), content, "utf8");
  }

  for (const [relativePath, content] of Object.entries(options.topics ?? {})) {
    writeFileSync(join(vaultRoot, relativePath), content, "utf8");
  }

  const manifest: Manifest = {
    schema_version: "okf-vault-manifest/1.0.0",
    note_contract_version: NOTE_CONTRACT_VERSION,
    sources: options.sources,
  };
  saveManifest(vaultRoot, manifest);
}

describe("wikilink parsing and resolution", () => {
  it("extracts wikilinks and markdown links while skipping external URLs", () => {
    const content = [
      "See [[notes/b.md]] and [[Alias|notes/c.md]].",
      "Also [Note D](notes/d.md) and [Site](https://example.com).",
    ].join("\n");

    assert.deepEqual(extractLinkTargets(content), [
      "notes/b.md",
      "notes/c.md",
      "notes/d.md",
      "https://example.com",
    ]);
    assert.equal(resolveLinkTarget("notes/a.md", "notes/b.md"), "notes/b.md");
    assert.equal(resolveLinkTarget("notes/a.md", "https://example.com"), null);
  });

  it("resolves alias-style wikilinks and relative targets from the source directory", () => {
    assert.equal(resolveLinkTarget("notes/a.md", "b.md"), "notes/b.md");
    assert.equal(resolveLinkTarget("topics/map.md", "../notes/a.md"), "notes/a.md");
    assert.equal(resolveLinkTarget("notes/a.md", "../evil.md"), null);
  });
});

describe("graph validation outcomes", () => {
  it("passes when indexed notes are linked within two hops from the root index", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-pass-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n",
      notesIndex: "# Notes\n\n- [A](notes/a.md)\n- [B](notes/b.md)\n",
      topicsIndex: "# Topics\n",
      notes: {
        "notes/a.md": "# A\n\nSee [[notes/b.md]].\n",
        "notes/b.md": "# B\n",
      },
      sources: [
        committedRecord("notes/a.md", "local:/a", VALID_SHA),
        committedRecord("notes/b.md", "local:/b", VALID_SHA_B),
      ],
    });

    const result = validateVaultGraph(vaultRoot);
    assert.equal(result.report.status, "pass");
    assert.equal(result.report.issues.length, 0);
  });

  it("reports broken wikilink targets with source and target paths", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-broken-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n",
      notesIndex: "# Notes\n\n- [A](notes/a.md)\n",
      topicsIndex: "# Topics\n",
      notes: {
        "notes/a.md": "# A\n\nBroken [[notes/missing.md]].\n",
      },
      sources: [committedRecord("notes/a.md", "local:/a")],
    });

    const result = validateVaultGraph(vaultRoot);
    assert.equal(result.report.status, "fail");
    const broken = result.report.issues.find((entry) => entry.code === "BROKEN_LINK_TARGET");
    assert.ok(broken);
    assert.equal(broken?.path, "notes/a.md");
    assert.match(broken?.message ?? "", /notes\/a\.md/);
    assert.match(broken?.message ?? "", /notes\/missing\.md/);
  });

  it("reports orphan committed notes that lack any root navigation path", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-orphan-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n",
      notesIndex: "# Notes\n\n- [A](notes/a.md)\n",
      topicsIndex: "# Topics\n",
      notes: {
        "notes/a.md": "# A\n",
        "notes/orphan.md": "# Orphan\n",
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/orphan.md", "local:/orphan", VALID_SHA_C),
      ],
    });

    const result = validateVaultGraph(vaultRoot);
    const orphan = result.report.issues.find((entry) => entry.code === "ORPHAN_NOTE");
    assert.ok(orphan);
    assert.equal(orphan?.path, "notes/orphan.md");
  });

  it("fails two-hop reachability when a note is only reachable after three link hops", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-depth-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n",
      notesIndex: "# Notes\n\n- [A](notes/a.md)\n",
      topicsIndex: "# Topics\n",
      notes: {
        "notes/a.md": "# A\n\nSee [[notes/deep.md]].\n",
        "notes/deep.md": "# Deep\n",
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        committedRecord("notes/deep.md", "local:/deep", VALID_SHA_D),
      ],
    });

    const result = validateVaultGraph(vaultRoot);
    const unreachable = result.report.issues.find((entry) => entry.code === "UNREACHABLE_NOTE");
    assert.ok(unreachable);
    assert.equal(unreachable?.path, "notes/deep.md");
    assert.equal(
      result.report.issues.some(
        (entry) => entry.code === "ORPHAN_NOTE" && entry.path === "notes/deep.md",
      ),
      false,
    );
  });

  it("excludes skipped manifest records from orphan requirements", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-skipped-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n",
      notesIndex: "# Notes\n\n- [A](notes/a.md)\n",
      topicsIndex: "# Topics\n",
      notes: {
        "notes/a.md": "# A\n",
        "notes/skipped.md": "# Skipped\n",
      },
      sources: [
        committedRecord("notes/a.md", "local:/a"),
        skippedRecord("notes/skipped.md", "local:/skipped"),
      ],
    });

    const result = validateVaultGraph(vaultRoot);
    assert.equal(
      result.report.issues.some(
        (entry) => entry.code === "ORPHAN_NOTE" && entry.path === "notes/skipped.md",
      ),
      false,
    );
  });

  it("counts topic maps linked from topics/index.md toward reachability without duplicating source-note links", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-graph-topics-"));
    writeMinimalVault(vaultRoot, {
      rootIndex: "# Root\n\n- [Notes](notes/index.md)\n- [Topics](topics/index.md)\n",
      notesIndex: "# Notes\n\n- [C](notes/c.md)\n",
      topicsIndex: "# Topics\n\n- [Taxonomy](topics/taxonomy.md)\n",
      notes: {
        "notes/c.md": "# C\n",
      },
      topics: {
        "topics/taxonomy.md":
          "---\ntype: Topic Map\ntitle: Taxonomy\ndescription: Topic map\n---\n\n# Summary\n",
      },
      sources: [committedRecord("notes/c.md", "local:/c", VALID_SHA_C)],
    });

    const result = validateVaultGraph(vaultRoot);
    assert.equal(result.report.status, "pass");
    const graph = buildVaultLinkGraph(vaultRoot);
    assert.ok(graph.nodes.includes("topics/taxonomy.md"));
  });
});

describe("validate-graph CLI integration", () => {
  it("passes fixture vault navigation/pass with exit 0 and status pass", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-graph-pass-"));
    cpSync(join(navigationFixtures, "pass"), vaultRoot, { recursive: true });

    const outcome = dispatch(parseArgs(["validate-graph", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    assert.equal(outcome.result?.status, "ok");
    if (outcome.result?.status === "ok") {
      assert.equal(outcome.result.data.status, "pass");
    }
  });

  it("fails fixture vault navigation/orphan with exit 3 and lists the orphan path", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-graph-orphan-"));
    cpSync(join(navigationFixtures, "orphan"), vaultRoot, { recursive: true });
    const before = readFileSync(join(vaultRoot, "notes/orphan.md"), "utf8");

    const outcome = dispatch(parseArgs(["validate-graph", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);
    assert.equal(outcome.result?.status, "ok");
    if (outcome.result?.status === "ok") {
      const issues = outcome.result.data.issues as Array<{ code: string; path?: string }>;
      assert.ok(
        issues.some((entry) => entry.code === "ORPHAN_NOTE" && entry.path === "notes/orphan.md"),
      );
    }

    const after = readFileSync(join(vaultRoot, "notes/orphan.md"), "utf8");
    assert.equal(after, before);
  });

  it("returns structured initialization errors for uninitialized directories", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-graph-uninit-"));
    const outcome = dispatch(parseArgs(["validate-graph", vaultRoot]));
    assert.equal(outcome.exitCode, ExitCode.VALIDATION);
    assert.equal(outcome.result?.status, "error");
    assert.equal(outcome.result?.code, "VAULT_NOT_INITIALIZED");
  });

  it("runs through the compiled executable without modifying fixture files", () => {
    const bin = join(root, "dist", "main.js");
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-cli-graph-bin-"));
    cpSync(join(navigationFixtures, "pass"), vaultRoot, { recursive: true });

    const result = spawnSync(process.execPath, [bin, "validate-graph", vaultRoot], {
      encoding: "utf8",
    });
    assert.equal(result.status, ExitCode.SUCCESS);
    assert.match(result.stdout, /"status":"pass"/);
    assert.equal(existsSync(join(vaultRoot, "notes/a.md")), true);
  });
});
