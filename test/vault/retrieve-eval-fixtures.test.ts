import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RetrieveEvalCase } from "../../dist/vault/retrieve.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..", "..");

const fixturePath = join(projectRoot, "test", "fixtures", "retrieve-eval", "eval-cases.json");

const evalVaultRoot = join(projectRoot, "test", "fixtures", "vaults", "retrieve-eval");

// ---------------------------------------------------------------------------
// Task 12 — Eval fixture corpus
// ---------------------------------------------------------------------------

describe("eval fixture corpus", () => {
  it("fixture file exists at the expected path", () => {
    assert.ok(existsSync(fixturePath), `Expected eval-cases.json at ${fixturePath}`);
  });

  it("fixture file is valid JSON", () => {
    const raw = readFileSync(fixturePath, "utf8");
    let parsed: unknown;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(raw);
    }, "eval-cases.json must parse as valid JSON");
    assert.ok(Array.isArray(parsed), "eval-cases.json must be a JSON array");
  });

  it("each case has a non-empty query string", () => {
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as RetrieveEvalCase[];
    for (let i = 0; i < cases.length; i++) {
      const entry = cases[i] as RetrieveEvalCase;
      assert.ok(
        typeof entry.query === "string" && entry.query.trim().length > 0,
        `entry[${i}].query must be a non-empty string`,
      );
    }
  });

  it("each case has a non-empty expected_topic_paths array", () => {
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as RetrieveEvalCase[];
    for (let i = 0; i < cases.length; i++) {
      const entry = cases[i] as RetrieveEvalCase;
      assert.ok(
        Array.isArray(entry.expected_topic_paths) && entry.expected_topic_paths.length > 0,
        `entry[${i}].expected_topic_paths must be a non-empty array`,
      );
    }
  });

  it("contains at least 8 eval cases", () => {
    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as RetrieveEvalCase[];
    assert.ok(cases.length >= 8, `Expected at least 8 eval cases, got ${cases.length}`);
  });

  it("eval vault fixture exists and has a valid manifest", () => {
    const manifestPath = join(evalVaultRoot, ".okf-vault", "manifest.json");
    assert.ok(existsSync(manifestPath), `Expected manifest.json at ${manifestPath}`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.schema_version, "okf-vault-manifest/1.0.0");
  });

  it("eval vault topics directory contains the expected topic map files", () => {
    const topicsDir = join(evalVaultRoot, "topics");
    assert.ok(existsSync(topicsDir), "topics/ directory must exist in eval vault");
    const files = readdirSync(topicsDir)
      .filter((f) => f.endsWith(".md") && f !== "index.md")
      .sort();
    const expectedTopics = [
      "dados.md",
      "engineering.md",
      "finance.md",
      "leadership.md",
      "produto.md",
      "strategy.md",
    ];
    for (const expected of expectedTopics) {
      assert.ok(files.includes(expected), `Expected topic map ${expected} in eval vault topics/`);
    }
  });

  it("has at least one eval case per topic map in the eval vault", () => {
    const topicsDir = join(evalVaultRoot, "topics");
    const topicFiles = readdirSync(topicsDir)
      .filter((f) => f.endsWith(".md") && f !== "index.md")
      .map((f) => `topics/${f}`);

    const cases = JSON.parse(readFileSync(fixturePath, "utf8")) as RetrieveEvalCase[];
    const allExpected = cases.flatMap((c) => c.expected_topic_paths);

    for (const topicPath of topicFiles) {
      const topicBasename = topicPath.split("/").pop() as string;
      const covered = allExpected.some((p) => p === topicPath || p.endsWith(topicBasename));
      assert.ok(covered, `Topic map ${topicPath} has no coverage in eval-cases.json`);
    }
  });
});
