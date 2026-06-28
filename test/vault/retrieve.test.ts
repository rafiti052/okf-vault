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
import { isValidVaultRoot, resolveVaultRoot, handleRetrieve, loadTopicCandidateFiles, parseTopicCandidateFile, tokenize, scoreCandidate, rankCandidates, assignConfidence, selectResults, generateBroadeningHints, extractNoteSummary, hydrateLinkedNotes } from "../../dist/vault/retrieve.js";

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

// ---------------------------------------------------------------------------
// tokenize — unit tests (Task 06)
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  it("lowercases tokens", () => {
    const tokens = tokenize("Agent Workflows");
    assert.deepEqual(tokens, ["agent", "workflows"]);
  });

  it("splits on whitespace and punctuation", () => {
    const tokens = tokenize("agents, automation; workflows");
    assert.deepEqual(tokens, ["agents", "automation", "workflows"]);
  });

  it("strips diacritics (Portuguese normalization)", () => {
    // 'automação' -> 'automacao', 'estratégia' -> 'estrategia'
    const tokens = tokenize("automação estratégia");
    assert.deepEqual(tokens, ["automacao", "estrategia"]);
  });

  it("strips short noise tokens (length < 2)", () => {
    const tokens = tokenize("a agent b");
    // 'a' and 'b' are length 1, should be filtered
    assert.deepEqual(tokens, ["agent"]);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(tokenize(""), []);
  });

  it("handles mixed Portuguese and English content", () => {
    const tokens = tokenize("agentes e agents");
    // 'e' is length 1 and filtered
    assert.deepEqual(tokens, ["agentes", "agents"]);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — unit tests (Task 06)
// ---------------------------------------------------------------------------

/** Build a minimal TopicMapCandidate for scorer unit tests. */
function makeCandidate(
  overrides: Partial<import("../../dist/vault/retrieve.js").TopicMapCandidate>,
): import("../../dist/vault/retrieve.js").TopicMapCandidate {
  return {
    path: "/fake/vault/topics/test.md",
    title: "",
    tags: [],
    description: "",
    prose: "",
    linkedNotePaths: [],
    ...overrides,
  };
}

describe("scoreCandidate — basic behavior", () => {
  it("returns 0 for empty query", () => {
    const candidate = makeCandidate({ title: "Agent Workflows", prose: "Agents are useful." });
    assert.equal(scoreCandidate("", candidate), 0);
  });

  it("returns 0 when no query tokens match any field", () => {
    const candidate = makeCandidate({ title: "Agent Workflows", prose: "Some content here." });
    assert.equal(scoreCandidate("database schema", candidate), 0);
  });

  it("returns a positive score when a query token matches the title", () => {
    const candidate = makeCandidate({ title: "Agent Workflows" });
    assert.ok(scoreCandidate("agent", candidate) > 0);
  });

  it("produces deterministic scores for identical inputs", () => {
    const candidate = makeCandidate({
      title: "Agent Workflows",
      tags: ["agents", "automation"],
      description: "Notes about agents.",
      prose: "Agents automate processes.",
    });
    const score1 = scoreCandidate("agents automation", candidate);
    const score2 = scoreCandidate("agents automation", candidate);
    assert.equal(score1, score2);
  });
});

describe("scoreCandidate — field weight ordering", () => {
  it("title match outscores an equivalent prose-only match", () => {
    // candidate A has the query term in the title
    const titleCandidate = makeCandidate({ title: "Agents", prose: "Other content." });
    // candidate B has the query term only in prose
    const proseCandidate = makeCandidate({ title: "Other Topic", prose: "Agents here." });

    const titleScore = scoreCandidate("agents", titleCandidate);
    const proseScore = scoreCandidate("agents", proseCandidate);

    assert.ok(titleScore > proseScore, `Title score ${titleScore} should exceed prose score ${proseScore}`);
  });

  it("tag match outscores an equivalent prose-only match", () => {
    const tagCandidate = makeCandidate({ tags: ["agents"], prose: "Other content." });
    const proseCandidate = makeCandidate({ tags: [], prose: "Agents here." });

    const tagScore = scoreCandidate("agents", tagCandidate);
    const proseScore = scoreCandidate("agents", proseCandidate);

    assert.ok(tagScore > proseScore, `Tag score ${tagScore} should exceed prose score ${proseScore}`);
  });

  it("description match outscores an equivalent prose-only match", () => {
    const descCandidate = makeCandidate({ description: "Notes about agents.", prose: "Other content." });
    const proseCandidate = makeCandidate({ description: "", prose: "Notes about agents." });

    const descScore = scoreCandidate("agents", descCandidate);
    const proseScore = scoreCandidate("agents", proseCandidate);

    assert.ok(descScore > proseScore, `Description score ${descScore} should exceed prose score ${proseScore}`);
  });

  it("title + tag + description + prose match accumulates contributions from all fields", () => {
    const allFields = makeCandidate({
      title: "Agent",
      tags: ["agent"],
      description: "About agent systems.",
      prose: "Agent workflows explained.",
    });
    const proseOnly = makeCandidate({
      title: "",
      tags: [],
      description: "",
      prose: "Agent workflows explained.",
    });

    assert.ok(
      scoreCandidate("agent", allFields) > scoreCandidate("agent", proseOnly),
      "all-fields candidate should outscore prose-only candidate",
    );
  });
});

describe("scoreCandidate — bilingual normalization", () => {
  it("matches diacritic-stripped query tokens against accented candidate fields", () => {
    // query: 'automacao' (no accent); candidate tag has 'automação' (with accent)
    const candidate = makeCandidate({ tags: ["automação"] });
    // After normalization both become 'automacao'
    assert.ok(scoreCandidate("automacao", candidate) > 0);
  });

  it("matches accented query tokens against accented candidate fields after normalization", () => {
    const candidate = makeCandidate({ tags: ["estratégia"] });
    // Both normalize to 'estrategia'
    assert.ok(scoreCandidate("estratégia", candidate) > 0);
  });

  it("bilingual overlap scores consistently regardless of token language", () => {
    const candidate = makeCandidate({
      tags: ["agentes", "agents"],
      description: "Tópico sobre agentes de IA e agent workflows.",
    });
    // Portuguese query
    const ptScore = scoreCandidate("agentes", candidate);
    // English query
    const enScore = scoreCandidate("agents", candidate);

    // Both should be positive (both tokens exist in the candidate)
    assert.ok(ptScore > 0, "Portuguese token should score positively");
    assert.ok(enScore > 0, "English token should score positively");
  });
});

// ---------------------------------------------------------------------------
// rankCandidates — unit tests (Task 06)
// ---------------------------------------------------------------------------

describe("rankCandidates", () => {
  it("returns candidates sorted by score descending", () => {
    const strong = makeCandidate({
      path: "/fake/vault/topics/agents.md",
      title: "Agent Workflows",
      tags: ["agents", "automation"],
      description: "Notes on agents.",
      prose: "Agents automate tasks.",
    });
    const weak = makeCandidate({
      path: "/fake/vault/topics/strategy.md",
      title: "Strategy",
      tags: ["planning"],
      description: "Notes on strategy.",
      prose: "Agents are rarely mentioned here.",
    });
    const unrelated = makeCandidate({
      path: "/fake/vault/topics/databases.md",
      title: "Databases",
      tags: ["sql"],
      description: "Database notes.",
      prose: "SQL and schema design.",
    });

    const ranked = rankCandidates("agents automation", [unrelated, weak, strong]);
    assert.equal(ranked.length, 3);
    // strong candidate should be ranked first
    assert.ok(ranked[0]!.candidate.path.endsWith("agents.md"));
    assert.ok(ranked[0]!.score > ranked[1]!.score);
  });

  it("returns empty array for empty candidates list", () => {
    const ranked = rankCandidates("agents", []);
    assert.deepEqual(ranked, []);
  });

  it("is deterministic — same ranking on repeated calls", () => {
    const candidates = [
      makeCandidate({ path: "/a.md", title: "Alpha", prose: "Agent workflows." }),
      makeCandidate({ path: "/b.md", title: "Beta", prose: "Agents and automation." }),
      makeCandidate({ path: "/c.md", title: "Gamma", prose: "Strategy planning." }),
    ];

    const first = rankCandidates("agents", candidates).map((r) => r.candidate.path);
    const second = rankCandidates("agents", candidates).map((r) => r.candidate.path);
    assert.deepEqual(first, second);
  });

  it("breaks score ties by path ascending for stable ordering", () => {
    // Both candidates have the exact same content except path
    const base = { title: "Agent", tags: ["agent"], description: "", prose: "" };
    const c1 = makeCandidate({ ...base, path: "/z.md" });
    const c2 = makeCandidate({ ...base, path: "/a.md" });

    const ranked = rankCandidates("agent", [c1, c2]);
    // a.md should come before z.md (ascending path sort for ties)
    assert.equal(ranked[0]!.candidate.path, "/a.md");
    assert.equal(ranked[1]!.candidate.path, "/z.md");
  });

  it("zero-score candidates appear after positive-score candidates", () => {
    const match = makeCandidate({ path: "/match.md", title: "Agents" });
    const noMatch = makeCandidate({ path: "/nomatch.md", title: "Databases" });

    const ranked = rankCandidates("agents", [noMatch, match]);
    assert.equal(ranked[0]!.candidate.path, "/match.md");
    assert.equal(ranked[0]!.score, 10); // title weight
    assert.equal(ranked[1]!.score, 0);
  });
});

// ---------------------------------------------------------------------------
// scoreCandidate — integration: realistic ranking (Task 06)
// ---------------------------------------------------------------------------

describe("scoreCandidate — integration: realistic topic ranking", () => {
  it("ranks the expected agent-workflows topic above an unrelated strategy topic", () => {
    const agentTopic = makeCandidate({
      path: "/vault/topics/agents.md",
      title: "Agent Workflows",
      tags: ["agents", "automation", "agentic"],
      description: "Notes about agentic systems, LLM workflows, and automation.",
      prose:
        "This topic covers AI agent workflows, orchestration patterns, tool use, and autonomous task execution. " +
        "Topics include multi-agent coordination, memory systems, and MCP integration.",
    });

    const strategyTopic = makeCandidate({
      path: "/vault/topics/strategy.md",
      title: "Estratégia Organizacional",
      tags: ["estrategia", "planejamento", "okrs"],
      description: "Notas sobre estratégia, planejamento e OKRs.",
      prose:
        "Este tópico cobre planejamento estratégico, definição de OKRs, e alinhamento organizacional. " +
        "Inclui notas sobre ciclos de revisão e objetivos de longo prazo.",
    });

    const agentScore = scoreCandidate("agent workflows automation", agentTopic);
    const strategyScore = scoreCandidate("agent workflows automation", strategyTopic);

    assert.ok(
      agentScore > strategyScore,
      `Agent topic (${agentScore}) should outscore strategy topic (${strategyScore}) for query "agent workflows automation"`,
    );
  });

  it("ranks the expected strategy topic above an unrelated agent topic for Portuguese query", () => {
    const agentTopic = makeCandidate({
      path: "/vault/topics/agents.md",
      title: "Agent Workflows",
      tags: ["agents", "automation", "agentic"],
      description: "Notes about agentic systems and LLM workflows.",
      prose: "AI agent workflows, orchestration, tool use, and autonomous task execution.",
    });

    const strategyTopic = makeCandidate({
      path: "/vault/topics/strategy.md",
      title: "Estratégia Organizacional",
      tags: ["estrategia", "planejamento", "okrs"],
      description: "Notas sobre estratégia, planejamento e OKRs.",
      prose: "Planejamento estratégico, OKRs, alinhamento organizacional, revisão de ciclos.",
    });

    const agentScore = scoreCandidate("estrategia planejamento", agentTopic);
    const strategyScore = scoreCandidate("estrategia planejamento", strategyTopic);

    assert.ok(
      strategyScore > agentScore,
      `Strategy topic (${strategyScore}) should outscore agent topic (${agentScore}) for Portuguese query`,
    );
  });
});

// ---------------------------------------------------------------------------
// assignConfidence — unit tests (Task 07)
// ---------------------------------------------------------------------------

describe("assignConfidence — basic tier assignment", () => {
  it("returns 'low' when topScore is 0", () => {
    assert.equal(assignConfidence(0, [0, 0, 0]), "low");
  });

  it("returns 'low' when topScore is below minimum threshold (< 1)", () => {
    // topScore of 0 is below threshold
    assert.equal(assignConfidence(0, [0, 0, 5]), "low");
  });

  it("returns 'high' when topScore is clearly above median (dominance ratio >= 2.0)", () => {
    // topScore=20, median of [20, 5, 5, 5, 5] = 5 -> ratio 4.0 -> high
    assert.equal(assignConfidence(20, [20, 5, 5, 5, 5]), "high");
  });

  it("returns 'high' when median is 0 and topScore is positive", () => {
    // Only one candidate matched; median of [10, 0, 0, 0] = 0 -> high signal
    assert.equal(assignConfidence(10, [10, 0, 0, 0]), "high");
  });

  it("returns 'medium' when topScore is positive but dominance ratio < 2.0", () => {
    // topScore=10, scores=[10, 8, 7, 6] -> median=(8+7)/2=7.5 -> ratio ~1.33 -> medium
    assert.equal(assignConfidence(10, [10, 8, 7, 6]), "medium");
  });

  it("returns 'medium' for close scores across all candidates", () => {
    // All scores close together -> no single dominant winner
    assert.equal(assignConfidence(10, [10, 9, 9, 8]), "medium");
  });

  it("returns 'high' for single-candidate list with positive score", () => {
    // Only one candidate; median is that candidate's score -> ratio is 1.0
    // But median equals topScore, ratio = 1.0 < 2.0 -> should be medium
    // Unless median == topScore -> medium. Let's verify expected behavior.
    // topScore=10, scores=[10], median=10, ratio=1.0 -> medium
    assert.equal(assignConfidence(10, [10]), "medium");
  });

  it("uses full distribution to derive median, not just the top two", () => {
    // topScore=30, scores=[30, 1, 1, 1, 1, 1] -> median of 6 = (1+1)/2 = 1 -> ratio=30 -> high
    assert.equal(assignConfidence(30, [30, 1, 1, 1, 1, 1]), "high");
  });
});

// ---------------------------------------------------------------------------
// selectResults — unit tests (Task 07)
// ---------------------------------------------------------------------------

describe("selectResults — basic selection", () => {
  it("returns empty candidates and 'low' confidence for empty input", () => {
    const result = selectResults([]);
    assert.equal(result.confidence, "low");
    assert.deepEqual(result.candidates, []);
  });

  it("always includes the top candidate", () => {
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md", title: "Agents" }), score: 20 },
      { candidate: makeCandidate({ path: "/b.md", title: "Strategy" }), score: 5 },
    ];
    const result = selectResults(ranked);
    assert.equal(result.candidates.length >= 1, true);
    assert.equal(result.candidates[0]!.candidate.path, "/a.md");
  });

  it("includes secondary candidate within 80% of top score", () => {
    // topScore=10, window=8. Score 8 >= 8 -> included. Score 7 < 8 -> excluded.
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md" }), score: 10 },
      { candidate: makeCandidate({ path: "/b.md" }), score: 8 },
      { candidate: makeCandidate({ path: "/c.md" }), score: 7 },
    ];
    const result = selectResults(ranked);
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.some((r) => r.candidate.path === "/a.md"));
    assert.ok(result.candidates.some((r) => r.candidate.path === "/b.md"));
    assert.ok(!result.candidates.some((r) => r.candidate.path === "/c.md"));
  });

  it("excludes candidates below the 80% window", () => {
    const ranked = [
      { candidate: makeCandidate({ path: "/strong.md" }), score: 100 },
      { candidate: makeCandidate({ path: "/weak.md" }), score: 50 }, // 50 < 80 -> excluded
    ];
    const result = selectResults(ranked);
    assert.equal(result.candidates.length, 1);
    assert.equal(result.candidates[0]!.candidate.path, "/strong.md");
  });

  it("caps results at MAX_RESULTS (5) even when many candidates are within window", () => {
    // All 10 candidates at score 10 (all within 80% window of 10)
    const ranked = Array.from({ length: 10 }, (_, i) => ({
      candidate: makeCandidate({ path: `/${i}.md` }),
      score: 10,
    }));
    const result = selectResults(ranked);
    assert.equal(result.candidates.length, 5);
  });

  it("preserves descending score order in returned candidates", () => {
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md" }), score: 10 },
      { candidate: makeCandidate({ path: "/b.md" }), score: 9 },
      { candidate: makeCandidate({ path: "/c.md" }), score: 8 },
    ];
    const result = selectResults(ranked);
    const scores = result.candidates.map((r) => r.score);
    // Verify descending order is preserved
    for (let i = 1; i < scores.length; i++) {
      assert.ok((scores[i - 1] as number) >= (scores[i] as number));
    }
  });

  it("returns 'high' confidence when top score clearly dominates", () => {
    // topScore=40, others=5 -> ratio=8.0 -> high
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md" }), score: 40 },
      { candidate: makeCandidate({ path: "/b.md" }), score: 5 },
      { candidate: makeCandidate({ path: "/c.md" }), score: 5 },
    ];
    const result = selectResults(ranked);
    assert.equal(result.confidence, "high");
  });

  it("returns 'medium' confidence when top score does not clearly dominate", () => {
    // topScore=10, close scores -> medium
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md" }), score: 10 },
      { candidate: makeCandidate({ path: "/b.md" }), score: 9 },
      { candidate: makeCandidate({ path: "/c.md" }), score: 8 },
      { candidate: makeCandidate({ path: "/d.md" }), score: 7 },
    ];
    const result = selectResults(ranked);
    assert.equal(result.confidence, "medium");
  });

  it("returns 'low' confidence when top score is 0", () => {
    const ranked = [
      { candidate: makeCandidate({ path: "/a.md" }), score: 0 },
      { candidate: makeCandidate({ path: "/b.md" }), score: 0 },
    ];
    const result = selectResults(ranked);
    assert.equal(result.confidence, "low");
  });
});

// ---------------------------------------------------------------------------
// selectResults — integration: close thematic matches (Task 07)
// ---------------------------------------------------------------------------

describe("selectResults — integration: close thematic matches", () => {
  it("returns both candidates in deterministic order when two topics score closely", () => {
    // Build two candidates that both match "agent automation" well
    const agentTopic = makeCandidate({
      path: "/vault/topics/agents.md",
      title: "Agent Workflows",
      tags: ["agents", "automation"],
      description: "Notes on agent automation.",
      prose: "Agents automate tasks and workflows.",
    });
    const autoTopic = makeCandidate({
      path: "/vault/topics/automation.md",
      title: "Automation Systems",
      tags: ["automation", "agents"],
      description: "Automation notes.",
      prose: "Automation and agent-driven processes.",
    });
    const unrelatedTopic = makeCandidate({
      path: "/vault/topics/strategy.md",
      title: "Strategy",
      tags: ["planning"],
      description: "Strategy notes.",
      prose: "Long-term planning and OKRs.",
    });

    const ranked = rankCandidates("agent automation", [agentTopic, autoTopic, unrelatedTopic]);
    const result = selectResults(ranked);

    // Both agent and automation topics should appear (close scores)
    const paths = result.candidates.map((r) => r.candidate.path);
    assert.ok(paths.includes("/vault/topics/agents.md"), "agents.md should be in results");
    assert.ok(paths.includes("/vault/topics/automation.md"), "automation.md should be in results");

    // Results must be in descending score order (deterministic)
    const scores = result.candidates.map((r) => r.score);
    for (let i = 1; i < scores.length; i++) {
      assert.ok((scores[i - 1] as number) >= (scores[i] as number), "scores must be non-increasing");
    }
  });

  it("does not include unrelated low-scoring candidates in close-match set", () => {
    const strongA = makeCandidate({
      path: "/vault/topics/a.md",
      title: "Agent Workflows",
      tags: ["agents"],
      description: "Agent workflow notes.",
      prose: "Agents and workflows.",
    });
    const strongB = makeCandidate({
      path: "/vault/topics/b.md",
      title: "Agentic Systems",
      tags: ["agents"],
      description: "Notes on agentic systems.",
      prose: "Agentic automation.",
    });
    const weak = makeCandidate({
      path: "/vault/topics/unrelated.md",
      title: "Database Design",
      tags: ["sql"],
      description: "SQL and schema notes.",
      prose: "Database normalization.",
    });

    const ranked = rankCandidates("agents", [strongA, strongB, weak]);
    const result = selectResults(ranked);

    const paths = result.candidates.map((r) => r.candidate.path);
    assert.ok(!paths.includes("/vault/topics/unrelated.md"), "weak unrelated candidate must not appear");
  });
});

// ---------------------------------------------------------------------------
// generateBroadeningHints — unit tests (Task 08)
// ---------------------------------------------------------------------------

function makeCandidateForHints(
  path: string,
  tags: string[] = [],
  linkedNotePaths: string[] = [],
): import("../../dist/vault/retrieve.js").TopicMapCandidate {
  return makeCandidate({ path, title: path, tags, linkedNotePaths });
}

describe("generateBroadeningHints — confidence gating", () => {
  it("returns empty array when confidence is high and coverage_gap is false", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai", "agents"], ["/vault/notes/note1.md"]);
    const adjacent = makeCandidateForHints("/vault/topics/productivity.md", ["ai"], []);
    const hints = generateBroadeningHints("ai agents", "high", false, [{ candidate: selected, score: 30 }], [selected, adjacent]);
    assert.deepEqual(hints, []);
  });

  it("returns hints when confidence is medium", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai", "agents"], []);
    const adjacent = makeCandidateForHints("/vault/topics/productivity.md", ["ai"], []);
    const hints = generateBroadeningHints("ai agents", "medium", false, [{ candidate: selected, score: 10 }], [selected, adjacent]);
    assert.ok(hints.length > 0, "expected hints for medium confidence");
  });

  it("returns hints when confidence is low", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai"], []);
    const adjacent = makeCandidateForHints("/vault/topics/agents.md", ["ai"], []);
    const hints = generateBroadeningHints("ai", "low", false, [{ candidate: selected, score: 2 }], [selected, adjacent]);
    assert.ok(hints.length > 0, "expected hints for low confidence");
  });

  it("returns hints when confidence is high but coverage_gap is true", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai"], []);
    const adjacent = makeCandidateForHints("/vault/topics/agents.md", ["ai"], []);
    const hints = generateBroadeningHints("ai", "high", true, [{ candidate: selected, score: 30 }], [selected, adjacent]);
    assert.ok(hints.length > 0, "coverage_gap overrides high-confidence suppression");
  });
});

describe("generateBroadeningHints — shared-tag adjacency", () => {
  it("includes topic maps that share tags with the selected result", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai", "agents"], []);
    const sibling = makeCandidateForHints("/vault/topics/autonomous.md", ["agents"], []);
    const unrelated = makeCandidateForHints("/vault/topics/cooking.md", ["food"], []);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected, sibling, unrelated]);
    const hintPaths = hints.map((h) => h.topic_path);
    assert.ok(hintPaths.includes("/vault/topics/autonomous.md"), "shared-tag sibling must appear");
    assert.ok(!hintPaths.includes("/vault/topics/cooking.md"), "unrelated topic must not appear");
  });

  it("excludes the selected result itself from hints", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai"], []);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected]);
    assert.ok(!hints.map((h) => h.topic_path).includes("/vault/topics/ai.md"));
  });

  it("emits reason string describing the shared tags", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["agents"], []);
    const sibling = makeCandidateForHints("/vault/topics/autonomous.md", ["agents"], []);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected, sibling]);
    assert.ok(hints.length > 0);
    assert.ok(hints[0]?.reason.includes("agents"));
  });

  it("tag matching is case-insensitive", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["Agents"], []);
    const sibling = makeCandidateForHints("/vault/topics/autonomous.md", ["agents"], []);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected, sibling]);
    assert.ok(hints.map((h) => h.topic_path).includes("/vault/topics/autonomous.md"));
  });
});

describe("generateBroadeningHints — shared linked-note adjacency", () => {
  it("includes topic maps that share a linked note with the selected result", () => {
    const note = "/vault/notes/shared.md";
    const selected = makeCandidateForHints("/vault/topics/ai.md", [], [note]);
    const sibling = makeCandidateForHints("/vault/topics/automation.md", [], [note]);
    const unrelated = makeCandidateForHints("/vault/topics/cooking.md", [], ["/vault/notes/food.md"]);
    const hints = generateBroadeningHints("agents", "medium", false, [{ candidate: selected, score: 5 }], [selected, sibling, unrelated]);
    const hintPaths = hints.map((h) => h.topic_path);
    assert.ok(hintPaths.includes("/vault/topics/automation.md"));
    assert.ok(!hintPaths.includes("/vault/topics/cooking.md"));
  });

  it("a topic with both shared tag and shared note appears only once", () => {
    const note = "/vault/notes/shared.md";
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["agents"], [note]);
    const sibling = makeCandidateForHints("/vault/topics/autonomous.md", ["agents"], [note]);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected, sibling]);
    assert.equal(hints.filter((h) => h.topic_path === "/vault/topics/autonomous.md").length, 1);
  });
});

describe("generateBroadeningHints — bounded output and suggested queries", () => {
  it("caps total hints at 5", () => {
    const selected = makeCandidateForHints("/vault/topics/main.md", ["ai"], []);
    const siblings = Array.from({ length: 10 }, (_, i) => makeCandidateForHints(`/vault/topics/s${i}.md`, ["ai"], []));
    const hints = generateBroadeningHints("something", "medium", false, [{ candidate: selected, score: 5 }], [selected, ...siblings]);
    assert.ok(hints.length <= 5);
  });

  it("returns empty array when no adjacent topics exist", () => {
    const selected = makeCandidateForHints("/vault/topics/main.md", ["rare"], []);
    const unrelated = makeCandidateForHints("/vault/topics/other.md", ["different"], []);
    const hints = generateBroadeningHints("query", "medium", false, [{ candidate: selected, score: 5 }], [selected, unrelated]);
    assert.deepEqual(hints, []);
  });

  it("output is deterministic across calls", () => {
    const selected = makeCandidateForHints("/vault/topics/main.md", ["ai"], []);
    const siblings = ["a", "b", "c"].map((x) => makeCandidateForHints(`/vault/topics/${x}.md`, ["ai"], []));
    const all = [selected, ...siblings];
    const h1 = generateBroadeningHints("q", "medium", false, [{ candidate: selected, score: 5 }], all).map((h) => h.topic_path);
    const h2 = generateBroadeningHints("q", "medium", false, [{ candidate: selected, score: 5 }], all).map((h) => h.topic_path);
    assert.deepEqual(h1, h2);
  });

  it("attaches suggested_query from tag vocabulary not in original query", () => {
    const selected = makeCandidateForHints("/vault/topics/ai.md", ["ai", "autonomous-agents"], []);
    const sibling = makeCandidateForHints("/vault/topics/automation.md", ["ai"], []);
    const hints = generateBroadeningHints("ai", "medium", false, [{ candidate: selected, score: 10 }], [selected, sibling]);
    const withQuery = hints.filter((h) => h.suggested_query !== undefined);
    assert.ok(withQuery.length > 0, "expected suggested_query on at least one hint");
    assert.ok(withQuery[0]?.suggested_query?.includes("autonomous"));
  });
});

// ---------------------------------------------------------------------------
// extractNoteSummary — unit tests (Task 09)
// ---------------------------------------------------------------------------

describe("extractNoteSummary", () => {
  it("returns the first prose paragraph from a note without frontmatter", () => {
    const content = "First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph.";
    const summary = extractNoteSummary(content);
    assert.equal(summary, "First paragraph line one. First paragraph line two.");
  });

  it("strips frontmatter and extracts prose from the body", () => {
    const content = [
      "---",
      "title: My Note",
      "tags: [foo]",
      "---",
      "",
      "This is the first prose paragraph.",
      "",
      "Second paragraph.",
    ].join("\n");
    const summary = extractNoteSummary(content);
    assert.equal(summary, "This is the first prose paragraph.");
  });

  it("skips leading headings before the first prose paragraph", () => {
    const content = [
      "# Note Title",
      "",
      "## Section",
      "",
      "Actual prose starts here.",
    ].join("\n");
    const summary = extractNoteSummary(content);
    assert.equal(summary, "Actual prose starts here.");
  });

  it("truncates summary at 512 characters", () => {
    const longLine = "a".repeat(600);
    const content = longLine;
    const summary = extractNoteSummary(content);
    assert.equal(summary.length, 512);
    assert.equal(summary, longLine.slice(0, 512));
  });

  it("returns empty string when note has no prose content", () => {
    const content = "# Heading Only\n\n## Another Heading\n";
    const summary = extractNoteSummary(content);
    assert.equal(summary, "");
  });

  it("returns empty string for an empty file", () => {
    assert.equal(extractNoteSummary(""), "");
  });

  it("handles frontmatter with CRLF line endings", () => {
    const content = "---\r\ntitle: Note\r\n---\r\n\r\nProse line.\r\n";
    const summary = extractNoteSummary(content);
    assert.equal(summary, "Prose line.");
  });

  it("skips blank lines at the start of body after frontmatter", () => {
    const content = [
      "---",
      "title: Note",
      "---",
      "",
      "",
      "First prose paragraph here.",
    ].join("\n");
    const summary = extractNoteSummary(content);
    assert.equal(summary, "First prose paragraph here.");
  });
});

// ---------------------------------------------------------------------------
// hydrateLinkedNotes — unit tests (Task 09)
// ---------------------------------------------------------------------------

/** Build a minimal TopicMapCandidate for hydration tests. */
function makeCandidateWithLinks(linkedNotePaths: string[]): ReturnType<typeof makeCandidate> & { linkedNotePaths: string[] } {
  return {
    ...makeCandidate({ path: "/vault/topics/t.md" }),
    linkedNotePaths,
  };
}

describe("hydrateLinkedNotes — missing note handling", () => {
  it("returns empty array when candidate has no linked note paths", () => {
    const vault = makeVaultRoot();
    const candidate = makeCandidateWithLinks([]);
    const notes = hydrateLinkedNotes(candidate, vault);
    assert.deepEqual(notes, []);
  });

  it("skips missing linked note files deterministically without throwing", () => {
    const vault = makeVaultRoot();
    const candidate = makeCandidateWithLinks(["/does/not/exist/note.md"]);
    const notes = hydrateLinkedNotes(candidate, vault);
    assert.deepEqual(notes, []);
  });

  it("skips unreadable files and still returns readable ones", () => {
    const vault = makeVaultRoot();
    const notesDir = join(vault, "notes");
    mkdirSync(notesDir, { recursive: true });
    const goodPath = join(notesDir, "good.md");
    writeFileSync(goodPath, "Good prose content.\n", "utf8");

    const candidate = makeCandidateWithLinks(["/missing/bad.md", goodPath]);
    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.path, goodPath);
    assert.equal(notes[0]?.summary, "Good prose content.");
  });
});

describe("hydrateLinkedNotes — summary extraction", () => {
  it("extracts bounded summary from a readable note", () => {
    const vault = makeVaultRoot();
    const notesDir = join(vault, "notes");
    mkdirSync(notesDir, { recursive: true });
    const notePath = join(notesDir, "note.md");
    writeFileSync(notePath, [
      "---",
      "title: Test Note",
      "---",
      "",
      "This note discusses topic retrieval in detail.",
    ].join("\n"), "utf8");

    const candidate = makeCandidateWithLinks([notePath]);
    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.summary, "This note discusses topic retrieval in detail.");
  });

  it("attaches empty provenance (source_key and kind are empty strings)", () => {
    const vault = makeVaultRoot();
    const notesDir = join(vault, "notes");
    mkdirSync(notesDir, { recursive: true });
    const notePath = join(notesDir, "prov.md");
    writeFileSync(notePath, "Provenance test note.\n", "utf8");

    const candidate = makeCandidateWithLinks([notePath]);
    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1);
    assert.deepEqual(notes[0]?.provenance, { source_key: "", kind: "" });
  });

  it("summary is bounded to 512 characters", () => {
    const vault = makeVaultRoot();
    const notesDir = join(vault, "notes");
    mkdirSync(notesDir, { recursive: true });
    const notePath = join(notesDir, "long.md");
    const longContent = "x".repeat(600) + "\n";
    writeFileSync(notePath, longContent, "utf8");

    const candidate = makeCandidateWithLinks([notePath]);
    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1);
    assert.ok((notes[0]?.summary.length ?? 0) <= 512, "summary must not exceed 512 chars");
  });
});

describe("hydrateLinkedNotes — selected-result-only hydration", () => {
  it("only hydrates notes from paths explicitly listed in the candidate", () => {
    const vault = makeVaultRoot();
    const notesDir = join(vault, "notes");
    mkdirSync(notesDir, { recursive: true });

    // Write two notes but only link one.
    const linkedPath = join(notesDir, "linked.md");
    const unlinkedPath = join(notesDir, "unlinked.md");
    writeFileSync(linkedPath, "Linked note content.\n", "utf8");
    writeFileSync(unlinkedPath, "Unlinked note content.\n", "utf8");

    const candidate = makeCandidateWithLinks([linkedPath]);
    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1);
    assert.equal(notes[0]?.path, linkedPath);
    // Unlinked note must NOT appear.
    const paths = notes.map((n) => n.path);
    assert.ok(!paths.includes(unlinkedPath), "unlinked note must not be hydrated");
  });
});

// ---------------------------------------------------------------------------
// hydrateLinkedNotes — integration test (Task 09)
// ---------------------------------------------------------------------------

describe("hydrateLinkedNotes — integration: realistic topic result", () => {
  it("returns linked note summaries suitable for a retrieval response", () => {
    const vault = makeVaultRoot();
    const topicsDir = join(vault, "topics");
    const notesDir = join(vault, "notes");
    mkdirSync(topicsDir, { recursive: true });
    mkdirSync(notesDir, { recursive: true });

    const notePath = join(notesDir, "agent-note.md");
    writeFileSync(notePath, [
      "---",
      "title: Agent Workflows",
      "source_key: granola-abc",
      "kind: granola",
      "---",
      "",
      "This note describes how agents coordinate tasks using topic maps.",
      "",
      "More detail follows here.",
    ].join("\n"), "utf8");

    // Write a topic map that links to the note.
    const topicPath = join(topicsDir, "agents.md");
    writeFileSync(topicPath, [
      "---",
      "title: Agents",
      "tags: [agents, automation]",
      "description: Topic map for agent automation.",
      "---",
      "",
      "Overview of agent automation.",
      "",
      "## Notas neste tópico",
      "",
      `- [[../notes/agent-note]]`,
    ].join("\n"), "utf8");

    const rawFiles = loadTopicCandidateFiles(vault);
    assert.equal(rawFiles.length, 1);

    const candidate = parseTopicCandidateFile(rawFiles[0]!);
    // The candidate should have linkedNotePaths resolving to the note.
    assert.equal(candidate.linkedNotePaths.length, 1);

    const notes = hydrateLinkedNotes(candidate, vault);

    assert.equal(notes.length, 1, "one linked note should be hydrated");
    const note = notes[0]!;
    assert.equal(note.path, candidate.linkedNotePaths[0]);
    assert.ok(note.summary.length > 0, "summary must not be empty");
    assert.ok(note.summary.length <= 512, "summary must be bounded");
    assert.ok(
      note.summary.includes("agents coordinate tasks"),
      "summary must include first prose content",
    );
    // Provenance is empty at this stage (Task 10 fills it).
    assert.deepEqual(note.provenance, { source_key: "", kind: "" });
  });
});
