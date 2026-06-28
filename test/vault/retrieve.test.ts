import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CliError } from "../../dist/cli/cli.js";
import { ExitCode } from "../../dist/cli/cli.js";
import { initializeVault } from "../../dist/vault/manifest.js";
import { isValidVaultRoot, resolveVaultRoot, handleRetrieve, loadTopicCandidateFiles, parseTopicCandidateFile } from "../../dist/vault/retrieve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

/** Create a temp directory that is a fully initialized vault root. */
function makeVaultRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "okv-retrieve-test-"));
  initializeVault(dir);
  return dir;
}

/** Create a plain temp directory that is NOT a vault root. */
function makePlainDir(): string {
  return mkdtempSync(join(tmpdir(), "okv-plain-test-"));
}

/** Create a nested subdirectory inside a vault root (not the root itself). */
function makeNestedDir(vaultRoot: string): string {
  const nested = join(vaultRoot, "notes", "subdir");
  mkdirSync(nested, { recursive: true });
  return nested;
}

/** Assert that a CliResult is an error with a given code. */
function assertErrorCode(result: unknown, expectedCode: string): void {
  assert.ok(result != null, "result must not be null");
  const r = result as { status: string; code?: string };
  assert.equal(r.status, "error", `expected status "error", got "${r.status}"`);
  assert.equal((r as CliError).code, expectedCode);
}

// ---------------------------------------------------------------------------
// isValidVaultRoot
// ---------------------------------------------------------------------------

describe("isValidVaultRoot", () => {
  it("returns true for a properly initialized vault directory", () => {
    const vault = makeVaultRoot();
    assert.equal(isValidVaultRoot(vault), true);
  });

  it("returns false for a plain directory with no manifest", () => {
    const plain = makePlainDir();
    assert.equal(isValidVaultRoot(plain), false);
  });

  it("returns false for a nested directory inside a vault", () => {
    const vault = makeVaultRoot();
    const nested = makeNestedDir(vault);
    assert.equal(isValidVaultRoot(nested), false);
  });

  it("returns false for a non-existent directory", () => {
    assert.equal(isValidVaultRoot("/does/not/exist/ever"), false);
  });
});

// ---------------------------------------------------------------------------
// resolveVaultRoot — unit tests
// ---------------------------------------------------------------------------

describe("resolveVaultRoot", () => {
  it("uses explicit vault root when it is a valid vault root (first positional)", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot([vault, "my query"], () => makePlainDir());
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, ["my query"]);
  });

  it("returns all positionals as remainder when falling back to cwd", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot(["my query"], () => vault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, ["my query"]);
  });

  it("falls back to cwd when no positionals are supplied and cwd is a vault root", () => {
    const vault = makeVaultRoot();
    const result = resolveVaultRoot([], () => vault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    assert.equal(result.vaultRoot, vault);
    assert.deepEqual(result.remainder, []);
  });

  it("fails when first positional is not a vault root and cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = resolveVaultRoot(["just a query"], () => plain);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assert.equal(result.outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(result.outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("fails when cwd is a nested directory inside a vault (not the root)", () => {
    const vault = makeVaultRoot();
    const nested = makeNestedDir(vault);
    const result = resolveVaultRoot(["my query"], () => nested);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("unreachable");
    assertErrorCode(result.outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("prefers explicit vault root over a valid cwd vault", () => {
    const explicitVault = makeVaultRoot();
    const cwdVault = makeVaultRoot();
    const result = resolveVaultRoot([explicitVault, "my query"], () => cwdVault);
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("unreachable");
    // Must use the explicit vault, not the cwd vault
    assert.equal(result.vaultRoot, explicitVault);
    assert.deepEqual(result.remainder, ["my query"]);
  });
});

// ---------------------------------------------------------------------------
// handleRetrieve — integration-level tests
// ---------------------------------------------------------------------------

describe("handleRetrieve — query mode", () => {
  it("returns USAGE_MISSING_ARGS when no args supplied", () => {
    const outcome = handleRetrieve([], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "USAGE_MISSING_ARGS");
  });

  it("returns VAULT_ROOT_NOT_FOUND when cwd is not a vault root and single query supplied", () => {
    const plain = makePlainDir();
    const outcome = handleRetrieve(["my query"], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("returns USAGE_MISSING_QUERY when explicit vault root supplied but no query", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve([vault], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "USAGE_MISSING_QUERY");
  });

  it("reaches NOT_YET_IMPLEMENTED when explicit vault root and query supplied", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve([vault, "my query"], () => makePlainDir());
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("reaches NOT_YET_IMPLEMENTED when cwd is vault root and query supplied (cwd fallback)", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve(["my query"], () => vault);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });
});

describe("handleRetrieve — eval mode", () => {
  it("returns VAULT_ROOT_NOT_FOUND when --eval supplied with no vault root and bad cwd", () => {
    const plain = makePlainDir();
    const outcome = handleRetrieve(["--eval"], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });

  it("reaches NOT_YET_IMPLEMENTED when --eval with valid cwd vault root (cwd fallback)", () => {
    const vault = makeVaultRoot();
    const outcome = handleRetrieve(["--eval"], () => vault);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("reaches NOT_YET_IMPLEMENTED when --eval with explicit vault root", () => {
    const vault = makeVaultRoot();
    const plain = makePlainDir();
    const outcome = handleRetrieve(["--eval", vault], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "NOT_YET_IMPLEMENTED");
  });

  it("returns VAULT_ROOT_NOT_FOUND when --eval with explicit non-vault path and bad cwd", () => {
    const plain = makePlainDir();
    const anotherPlain = makePlainDir();
    const outcome = handleRetrieve(["--eval", anotherPlain], () => plain);
    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assertErrorCode(outcome.result, "VAULT_ROOT_NOT_FOUND");
  });
});

// ---------------------------------------------------------------------------
// CLI integration test — run built binary
// ---------------------------------------------------------------------------

describe("CLI integration — okv retrieve root resolution", () => {
  const cliPath = join(projectRoot, "dist", "main.js");

  it("exits with non-zero code and VAULT_ROOT_NOT_FOUND when cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "some query"], {
      cwd: plain,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /VAULT_ROOT_NOT_FOUND/);
  });

  it("exits with non-zero code and VAULT_ROOT_NOT_FOUND for --eval when cwd is not a vault root", () => {
    const plain = makePlainDir();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "--eval"], {
      cwd: plain,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    const output = result.stdout + result.stderr;
    assert.match(output, /VAULT_ROOT_NOT_FOUND/);
  });

  it("outputs NOT_YET_IMPLEMENTED when cwd is a valid vault root with query", () => {
    const vault = makeVaultRoot();
    const result = spawnSync(process.execPath, [cliPath, "--json", "retrieve", "agent workflows"], {
      cwd: vault,
      encoding: "utf8",
    });
    const output = result.stdout + result.stderr;
    assert.match(output, /NOT_YET_IMPLEMENTED/);
  });
});

// ---------------------------------------------------------------------------
// loadTopicCandidateFiles — unit tests (Task 04)
// ---------------------------------------------------------------------------

/** Create a vault root with a populated topics/ directory for loader tests. */
function makeVaultWithTopics(files: Record<string, string>): string {
  const vault = makeVaultRoot();
  const topicsDir = join(vault, "topics");
  mkdirSync(topicsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(topicsDir, name), content, "utf8");
  }
  return vault;
}

describe("loadTopicCandidateFiles", () => {
  it("returns empty array when topics/ directory does not exist", () => {
    const vault = makeVaultRoot();
    // topics/ is not created — loader must not throw
    const candidates = loadTopicCandidateFiles(vault);
    assert.deepEqual(candidates, []);
  });

  it("returns empty array when topics/ exists but has no markdown files", () => {
    const vault = makeVaultWithTopics({ "readme.txt": "plain text" });
    const candidates = loadTopicCandidateFiles(vault);
    assert.deepEqual(candidates, []);
  });

  it("returns empty array when topics/ contains only index.md", () => {
    const vault = makeVaultWithTopics({ "index.md": "# Topics\n" });
    const candidates = loadTopicCandidateFiles(vault);
    assert.deepEqual(candidates, []);
  });

  it("excludes index.md and non-markdown files, returns only topic map candidates", () => {
    const vault = makeVaultWithTopics({
      "index.md": "# Topics\n",
      "agents.md": "# Agent Workflows\n",
      "data.json": "{}",
      "notes.txt": "plain",
    });
    const candidates = loadTopicCandidateFiles(vault);
    assert.equal(candidates.length, 1);
    assert.ok(candidates[0]!.path.endsWith("agents.md"));
    assert.equal(candidates[0]!.content, "# Agent Workflows\n");
  });

  it("returns candidates in deterministic ascending filename order", () => {
    const vault = makeVaultWithTopics({
      "zebra.md": "# Zebra\n",
      "apple.md": "# Apple\n",
      "mango.md": "# Mango\n",
    });
    const candidates = loadTopicCandidateFiles(vault);
    assert.equal(candidates.length, 3);
    const names = candidates.map((c) => c.path.split("/").pop());
    assert.deepEqual(names, ["apple.md", "mango.md", "zebra.md"]);
  });

  it("ordering is stable across multiple calls", () => {
    const vault = makeVaultWithTopics({
      "c-topic.md": "# C\n",
      "a-topic.md": "# A\n",
      "b-topic.md": "# B\n",
    });
    const first = loadTopicCandidateFiles(vault).map((c) => c.path);
    const second = loadTopicCandidateFiles(vault).map((c) => c.path);
    assert.deepEqual(first, second);
  });

  it("returns raw file content without modification", () => {
    const content = "---\ntitle: My Topic\ntags: [foo, bar]\n---\n\n# My Topic\n\nSome prose.\n";
    const vault = makeVaultWithTopics({ "my-topic.md": content });
    const candidates = loadTopicCandidateFiles(vault);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.content, content);
  });

  it("integration: vault with no topic maps returns empty candidate set without crashing", () => {
    // Full integration scenario: initialized vault, topics/ dir created but empty
    const vault = makeVaultWithTopics({});
    const candidates = loadTopicCandidateFiles(vault);
    assert.equal(candidates.length, 0);
  });
});

// ---------------------------------------------------------------------------
// parseTopicCandidateFile — unit tests (Task 05)
// ---------------------------------------------------------------------------

/** Build a minimal RawTopicFile for parser unit tests. */
function makeRawFile(name: string, content: string): import("../../dist/vault/retrieve.js").RawTopicFile {
  return {
    path: join("/fake/vault/topics", name),
    content,
  };
}

describe("parseTopicCandidateFile — frontmatter extraction", () => {
  it("extracts title, tags, and description from valid frontmatter", () => {
    const raw = makeRawFile("agents.md", [
      "---",
      "title: Agent Workflows",
      "description: Notes about agentic systems.",
      "tags:",
      "  - agents",
      "  - automation",
      "---",
      "",
      "# Agent Workflows",
      "",
      "Prose about agents.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.path, raw.path);
    assert.equal(candidate.title, "Agent Workflows");
    assert.equal(candidate.description, "Notes about agentic systems.");
    assert.deepEqual(candidate.tags, ["agents", "automation"]);
  });

  it("falls back to first heading when frontmatter has no title", () => {
    const raw = makeRawFile("agents.md", [
      "---",
      "tags: [agents]",
      "---",
      "",
      "# Agent Systems",
      "",
      "Prose here.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.title, "Agent Systems");
  });

  it("emits empty title when frontmatter has no title and body has no heading", () => {
    const raw = makeRawFile("empty.md", [
      "---",
      "tags: [misc]",
      "---",
      "",
      "Just some prose without a heading.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.title, "");
  });

  it("emits empty description when frontmatter description is absent", () => {
    const raw = makeRawFile("no-desc.md", [
      "---",
      "title: My Topic",
      "tags: [misc]",
      "---",
      "",
      "Prose.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.description, "");
  });

  it("emits empty tags array when frontmatter tags is absent", () => {
    const raw = makeRawFile("no-tags.md", [
      "---",
      "title: No Tags",
      "---",
      "",
      "Prose.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.deepEqual(candidate.tags, []);
  });

  it("tolerates missing frontmatter block gracefully", () => {
    const raw = makeRawFile("bare.md", "# Bare Topic\n\nNo frontmatter here.\n");

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.title, "Bare Topic");
    assert.deepEqual(candidate.tags, []);
    assert.equal(candidate.description, "");
    // prose is the full content when there's no frontmatter
    assert.ok(candidate.prose.includes("No frontmatter here."));
  });

  it("tolerates unparseable frontmatter YAML gracefully", () => {
    const raw = makeRawFile("bad-yaml.md", [
      "---",
      ": this is invalid yaml: [unclosed",
      "---",
      "",
      "# Fallback Heading",
      "",
      "Prose.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    // Should not throw; title falls back to heading
    assert.equal(candidate.title, "Fallback Heading");
    assert.deepEqual(candidate.tags, []);
    assert.equal(candidate.description, "");
  });
});

describe("parseTopicCandidateFile — prose extraction", () => {
  it("prose contains the body text after frontmatter", () => {
    const raw = makeRawFile("topic.md", [
      "---",
      "title: My Topic",
      "---",
      "",
      "# My Topic",
      "",
      "First paragraph.",
      "",
      "## Details",
      "",
      "More detail.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.ok(candidate.prose.includes("First paragraph."));
    assert.ok(candidate.prose.includes("More detail."));
  });

  it("preserves bilingual Portuguese/English content in prose", () => {
    const raw = makeRawFile("bilingual.md", [
      "---",
      "title: Bilingual Topic",
      "description: Tópico bilíngue sobre agentes de IA e agent workflows.",
      "tags: [agentes, agents, automação]",
      "---",
      "",
      "# Bilingual Topic",
      "",
      "Este tópico descreve agent workflows e automação de processos.",
      "This topic describes agent workflows and process automation.",
      "",
      "## Notas neste tópico",
      "",
      "- [[notes/agent-note]]",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.ok(candidate.description.includes("agentes de IA"));
    assert.ok(candidate.description.includes("agent workflows"));
    assert.deepEqual(candidate.tags, ["agentes", "agents", "automação"]);
    assert.ok(candidate.prose.includes("automação de processos"));
    assert.ok(candidate.prose.includes("process automation"));
  });
});

describe("parseTopicCandidateFile — linked-note extraction", () => {
  it("extracts wikilinks from the body and resolves to absolute paths", () => {
    const topicsDir = "/fake/vault/topics";
    const raw = {
      path: join(topicsDir, "agents.md"),
      content: [
        "---",
        "title: Agents",
        "---",
        "",
        "## Notas neste tópico",
        "",
        "- [[notes/agent-one]]",
        "- [[notes/agent-two.md]]",
      ].join("\n"),
    };

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.linkedNotePaths.length, 2);
    // Both should be absolute paths
    assert.ok(candidate.linkedNotePaths[0]!.startsWith("/"));
    assert.ok(candidate.linkedNotePaths[1]!.startsWith("/"));
    // Extension appended when missing
    assert.ok(candidate.linkedNotePaths[0]!.endsWith("notes/agent-one.md"));
    // Preserved when present
    assert.ok(candidate.linkedNotePaths[1]!.endsWith("notes/agent-two.md"));
  });

  it("returns empty linkedNotePaths when body contains no wikilinks", () => {
    const raw = makeRawFile("no-links.md", [
      "---",
      "title: No Links",
      "---",
      "",
      "Prose without any links.",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.deepEqual(candidate.linkedNotePaths, []);
  });

  it("deduplicates repeated wikilinks", () => {
    const raw = makeRawFile("dup-links.md", [
      "---",
      "title: Dup Links",
      "---",
      "",
      "- [[notes/note-a]]",
      "- [[notes/note-a]]",
      "- [[notes/note-b]]",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.linkedNotePaths.length, 2);
  });

  it("extracts wikilinks with display-text aliases ([[path|alias]])", () => {
    const raw = makeRawFile("aliased.md", [
      "---",
      "title: Aliased",
      "---",
      "",
      "- [[notes/note-a|Note A Display]]",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.linkedNotePaths.length, 1);
    assert.ok(candidate.linkedNotePaths[0]!.endsWith("notes/note-a.md"));
  });

  it("extracts linked notes from 'Notas neste tópico' section (Portuguese section heading)", () => {
    const raw = makeRawFile("pt-section.md", [
      "---",
      "title: Portuguese Topic",
      "---",
      "",
      "# Portuguese Topic",
      "",
      "Synthesized prose aqui.",
      "",
      "## Notas neste tópico",
      "",
      "- [[notes/nota-um]]",
      "- [[notes/nota-dois]]",
    ].join("\n"));

    const candidate = parseTopicCandidateFile(raw);
    assert.equal(candidate.linkedNotePaths.length, 2);
    assert.ok(candidate.linkedNotePaths[0]!.endsWith("notes/nota-um.md"));
    assert.ok(candidate.linkedNotePaths[1]!.endsWith("notes/nota-dois.md"));
  });
});

describe("parseTopicCandidateFile — integration with loadTopicCandidateFiles", () => {
  it("roundtrip: load then parse produces a valid candidate for each file", () => {
    const vault = makeVaultWithTopics({
      "agents.md": [
        "---",
        "title: Agent Workflows",
        "description: Notes about agents.",
        "tags: [agents, workflows]",
        "---",
        "",
        "# Agent Workflows",
        "",
        "Prose about agents and automation.",
        "",
        "## Notas neste tópico",
        "",
        "- [[notes/agent-one]]",
      ].join("\n"),
      "strategy.md": [
        "---",
        "title: Estratégia",
        "description: Tópico sobre estratégia.",
        "tags: [estrategia, strategy]",
        "---",
        "",
        "# Estratégia",
        "",
        "Notas sobre planejamento e estratégia organizacional.",
      ].join("\n"),
    });

    const raws = loadTopicCandidateFiles(vault);
    assert.equal(raws.length, 2);

    const candidates = raws.map(parseTopicCandidateFile);

    // agents.md
    const agentCandidate = candidates.find((c) => c.path.endsWith("agents.md"));
    assert.ok(agentCandidate !== undefined);
    assert.equal(agentCandidate.title, "Agent Workflows");
    assert.deepEqual(agentCandidate.tags, ["agents", "workflows"]);
    assert.equal(agentCandidate.description, "Notes about agents.");
    assert.ok(agentCandidate.prose.includes("automation"));
    assert.equal(agentCandidate.linkedNotePaths.length, 1);

    // strategy.md (bilingual)
    const strategyCandidate = candidates.find((c) => c.path.endsWith("strategy.md"));
    assert.ok(strategyCandidate !== undefined);
    assert.equal(strategyCandidate.title, "Estratégia");
    assert.deepEqual(strategyCandidate.tags, ["estrategia", "strategy"]);
    assert.ok(strategyCandidate.prose.includes("planejamento"));
    assert.equal(strategyCandidate.linkedNotePaths.length, 0);
  });

  it("parsing incomplete topic maps does not throw", () => {
    const vault = makeVaultWithTopics({
      "incomplete.md": "Just bare prose with no frontmatter or heading.",
      "no-title.md": "---\ntags: [misc]\n---\n\nSome prose.",
      "empty.md": "",
    });

    const raws = loadTopicCandidateFiles(vault);
    // All three files should parse without throwing
    assert.doesNotThrow(() => raws.map(parseTopicCandidateFile));
    const candidates = raws.map(parseTopicCandidateFile);
    assert.equal(candidates.length, 3);
    for (const c of candidates) {
      assert.ok(typeof c.title === "string");
      assert.ok(Array.isArray(c.tags));
      assert.ok(typeof c.description === "string");
      assert.ok(typeof c.prose === "string");
      assert.ok(Array.isArray(c.linkedNotePaths));
    }
  });
});
