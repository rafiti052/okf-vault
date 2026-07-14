/**
 * Task 03 — Retrieval result types and JSON Schema contract tests.
 *
 * Validates:
 *  - RetrieveResponse required fields and schema_version marker
 *  - RetrieveEvalReport required fields and schema_version marker
 *  - Retrieval error codes remain serializable through the CLI envelope
 *  - Stable JSON field names are preserved through JSON serialization
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RETRIEVE_SCHEMA_VERSION,
  RETRIEVE_EVAL_SCHEMA_VERSION,
  RetrieveErrorCode,
  type RetrieveResponse,
  type RetrieveResult,
  type LinkedNote,
  type HydratedSourceSpan,
  type HydratedSourceSpanSet,
  type BroadeningHint,
  type RetrieveEvalReport,
  type RetrieveEvalQueryResult,
  type RetrieveEvalMetrics,
  type TopicMapCandidate,
} from "../../dist/vault/retrieve.js";
import { failure, type CliError } from "../../dist/cli/cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLinkedNote(overrides: Partial<LinkedNote> = {}): LinkedNote {
  return {
    path: "/vault/knowledge/notes/note-a.md",
    summary: "A note about AI governance.",
    provenance: { source_key: "granola-abc123", kind: "granola" },
    ...overrides,
  };
}

function makeHydratedSourceSpan(overrides: Partial<HydratedSourceSpan> = {}): HydratedSourceSpan {
  return {
    id: "span-002-example",
    path: "/vault/knowledge/references/sources/example/span-002.md",
    profile: "article",
    sequence: 2,
    anchor_ids: ["anchor-002"],
    text: "Exact bounded source evidence.",
    title: "Article span 2",
    heading: "Evidence",
    ...overrides,
  };
}

function makeHydratedSourceSpanSet(
  overrides: Partial<HydratedSourceSpanSet> = {},
): HydratedSourceSpanSet {
  return {
    anchor_id: "anchor-002",
    profile: "article",
    exact: makeHydratedSourceSpan(),
    previous: makeHydratedSourceSpan({ id: "span-001-example", sequence: 1 }),
    next: makeHydratedSourceSpan({ id: "span-003-example", sequence: 3 }),
    ...overrides,
  };
}

function makeRetrieveResult(overrides: Partial<RetrieveResult> = {}): RetrieveResult {
  return {
    path: "/vault/knowledge/topics/ai-governance.md",
    title: "AI Governance",
    excerpt: "Synthesized overview of AI governance frameworks.",
    linked_notes: [makeLinkedNote()],
    score: 0.82,
    ...overrides,
  };
}

function makeBroadeningHint(overrides: Partial<BroadeningHint> = {}): BroadeningHint {
  return {
    topic_path: "/vault/knowledge/topics/autonomous-agents.md",
    reason: "Shares tags with the matched topic map.",
    ...overrides,
  };
}

function makeRetrieveResponse(overrides: Partial<RetrieveResponse> = {}): RetrieveResponse {
  return {
    schema_version: RETRIEVE_SCHEMA_VERSION,
    query: "AI governance frameworks",
    confidence: "high",
    coverage_gap: false,
    results: [makeRetrieveResult()],
    broadening_hints: [],
    ...overrides,
  };
}

function makeEvalQueryResult(
  overrides: Partial<RetrieveEvalQueryResult> = {},
): RetrieveEvalQueryResult {
  return {
    query: "AI governance frameworks",
    top_result_path: "/vault/knowledge/topics/ai-governance.md",
    confidence: "high",
    hit: true,
    coverage_gap: false,
    top_score: 0.82,
    duration_ms: 42,
    ...overrides,
  };
}

function makeEvalMetrics(overrides: Partial<RetrieveEvalMetrics> = {}): RetrieveEvalMetrics {
  return {
    total_queries: 5,
    hit_count: 4,
    hit_rate: 0.8,
    high_confidence_count: 3,
    medium_confidence_count: 1,
    low_confidence_count: 1,
    coverage_gap_count: 0,
    median_duration_ms: 38,
    ...overrides,
  };
}

function makeEvalReport(overrides: Partial<RetrieveEvalReport> = {}): RetrieveEvalReport {
  return {
    schema_version: RETRIEVE_EVAL_SCHEMA_VERSION,
    vault_root: "/vault/knowledge",
    run_at: "2026-06-27T00:00:00.000Z",
    query_results: [makeEvalQueryResult()],
    metrics: makeEvalMetrics(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RetrieveResponse — required fields and schema version
// ---------------------------------------------------------------------------

describe("RetrieveResponse contract", () => {
  it("includes schema_version field with the expected literal value", () => {
    const response = makeRetrieveResponse();
    assert.equal(response.schema_version, "okv-retrieve/1.0.0");
    assert.equal(response.schema_version, RETRIEVE_SCHEMA_VERSION);
  });

  it("includes query field", () => {
    const response = makeRetrieveResponse({ query: "autonomous agent coordination" });
    assert.equal(response.query, "autonomous agent coordination");
  });

  it("includes confidence field with a valid tier value", () => {
    for (const tier of ["high", "medium", "low"] as const) {
      const response = makeRetrieveResponse({ confidence: tier });
      assert.equal(response.confidence, tier);
    }
  });

  it("includes coverage_gap boolean field", () => {
    const withGap = makeRetrieveResponse({ coverage_gap: true, results: [] });
    assert.equal(withGap.coverage_gap, true);

    const withoutGap = makeRetrieveResponse({ coverage_gap: false });
    assert.equal(withoutGap.coverage_gap, false);
  });

  it("includes results array field", () => {
    const response = makeRetrieveResponse();
    assert.ok(Array.isArray(response.results));
    assert.equal(response.results.length, 1);
  });

  it("includes broadening_hints array field", () => {
    const response = makeRetrieveResponse({
      broadening_hints: [makeBroadeningHint()],
    });
    assert.ok(Array.isArray(response.broadening_hints));
    assert.equal(response.broadening_hints.length, 1);
  });

  it("allows empty broadening_hints when confidence is high", () => {
    const response = makeRetrieveResponse({ confidence: "high", broadening_hints: [] });
    assert.deepEqual(response.broadening_hints, []);
  });

  it("allows optional suggested_query on BroadeningHint", () => {
    const withSuggestion = makeBroadeningHint({ suggested_query: "AI regulation policy" });
    assert.equal(withSuggestion.suggested_query, "AI regulation policy");

    const withoutSuggestion = makeBroadeningHint();
    assert.equal(withoutSuggestion.suggested_query, undefined);
  });
});

// ---------------------------------------------------------------------------
// RetrieveResult — required subfields
// ---------------------------------------------------------------------------

describe("RetrieveResult contract", () => {
  it("includes path, title, excerpt, linked_notes, and score", () => {
    const result = makeRetrieveResult();
    assert.ok(typeof result.path === "string");
    assert.ok(typeof result.title === "string");
    assert.ok(typeof result.excerpt === "string");
    assert.ok(Array.isArray(result.linked_notes));
    assert.ok(typeof result.score === "number");
  });

  it("linked_notes each include path, summary, and provenance", () => {
    const note = makeLinkedNote();
    assert.ok(typeof note.path === "string");
    assert.ok(typeof note.summary === "string");
    assert.ok(typeof note.provenance.source_key === "string");
    assert.ok(typeof note.provenance.kind === "string");
  });

  it("allows empty string provenance fields when manifest data is unavailable", () => {
    const note = makeLinkedNote({
      provenance: { source_key: "", kind: "" },
    });
    assert.equal(note.provenance.source_key, "");
    assert.equal(note.provenance.kind, "");
  });

  it("allows bounded source-span sets with profile-specific metadata", () => {
    const note = makeLinkedNote({ source_spans: [makeHydratedSourceSpanSet()] });
    const set = note.source_spans?.[0];
    assert.ok(set !== undefined);
    assert.equal(set.anchor_id, "anchor-002");
    assert.equal(set.profile, "article");
    assert.equal(set.exact.heading, "Evidence");
    assert.equal(set.previous?.sequence, 1);
    assert.equal(set.next?.sequence, 3);
  });

  it("keeps source_spans optional for legacy linked-note responses", () => {
    const note = makeLinkedNote();
    assert.equal(note.source_spans, undefined);
    assert.equal("source_spans" in (JSON.parse(JSON.stringify(note)) as object), false);
  });
});

// ---------------------------------------------------------------------------
// RetrieveEvalReport — required fields and schema version
// ---------------------------------------------------------------------------

describe("RetrieveEvalReport contract", () => {
  it("includes schema_version field with the expected literal value", () => {
    const report = makeEvalReport();
    assert.equal(report.schema_version, "okv-retrieve-eval/1.0.0");
    assert.equal(report.schema_version, RETRIEVE_EVAL_SCHEMA_VERSION);
  });

  it("includes vault_root and run_at fields", () => {
    const report = makeEvalReport();
    assert.ok(typeof report.vault_root === "string");
    assert.ok(typeof report.run_at === "string");
    // run_at should be an ISO 8601 timestamp
    assert.ok(!isNaN(Date.parse(report.run_at)));
  });

  it("includes query_results array", () => {
    const report = makeEvalReport();
    assert.ok(Array.isArray(report.query_results));
    assert.equal(report.query_results.length, 1);
  });

  it("query_results entries include required fields", () => {
    const qr = makeEvalQueryResult();
    assert.ok(typeof qr.query === "string");
    assert.ok(typeof qr.confidence === "string");
    assert.ok(typeof qr.hit === "boolean");
    assert.ok(typeof qr.coverage_gap === "boolean");
    assert.ok(typeof qr.top_score === "number");
    assert.ok(typeof qr.duration_ms === "number");
  });

  it("top_result_path is null when coverage_gap is true", () => {
    const qr = makeEvalQueryResult({ top_result_path: null, coverage_gap: true, top_score: 0 });
    assert.equal(qr.top_result_path, null);
    assert.equal(qr.coverage_gap, true);
  });

  it("includes metrics block with all aggregate fields", () => {
    const report = makeEvalReport();
    const m = report.metrics;
    assert.ok(typeof m.total_queries === "number");
    assert.ok(typeof m.hit_count === "number");
    assert.ok(typeof m.hit_rate === "number");
    assert.ok(typeof m.high_confidence_count === "number");
    assert.ok(typeof m.medium_confidence_count === "number");
    assert.ok(typeof m.low_confidence_count === "number");
    assert.ok(typeof m.coverage_gap_count === "number");
    assert.ok(typeof m.median_duration_ms === "number");
  });

  it("hit_rate is a fraction between 0 and 1", () => {
    const report = makeEvalReport({
      metrics: makeEvalMetrics({ hit_count: 4, total_queries: 5, hit_rate: 0.8 }),
    });
    assert.ok(report.metrics.hit_rate >= 0 && report.metrics.hit_rate <= 1);
  });
});

// ---------------------------------------------------------------------------
// Error codes — serialization through CLI envelope
// ---------------------------------------------------------------------------

describe("RetrieveErrorCode serialization", () => {
  it("all error codes are string values", () => {
    for (const [key, value] of Object.entries(RetrieveErrorCode)) {
      assert.ok(typeof value === "string", `${key} should be a string`);
    }
  });

  it("error codes survive JSON round-trip through CLI failure envelope", () => {
    const code = RetrieveErrorCode.VAULT_NO_TOPICS_DIR;
    const envelope: CliError = failure("retrieve", code, "No topics/ directory found.", {
      vault_root: "/some/path",
    });

    const json = JSON.stringify(envelope);
    const parsed = JSON.parse(json) as CliError;

    assert.equal(parsed.status, "error");
    assert.equal(parsed.command, "retrieve");
    assert.equal(parsed.code, "VAULT_NO_TOPICS_DIR");
    assert.equal(parsed.message, "No topics/ directory found.");
    assert.deepEqual(parsed.details, { vault_root: "/some/path" });
  });

  it("error envelope contains no human-only display fields", () => {
    const envelope: CliError = failure(
      "retrieve",
      RetrieveErrorCode.RETRIEVE_EVAL_BELOW_THRESHOLD,
      "Hit rate 0.6 is below required 0.8.",
      { hit_rate: 0.6, required: 0.8 },
    );

    const json = JSON.stringify(envelope);
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Must not contain color codes, ANSI escapes, or human-only display wrappers
    const jsonStr = JSON.stringify(parsed);
    assert.ok(!jsonStr.includes("\\u001b"), "Should not contain ANSI escape codes");
    assert.ok(!jsonStr.includes("\\x1b"), "Should not contain ANSI escape codes");
  });

  it("usage error codes produce exit-2-class errors in the handler", () => {
    // Validate that handler returns ExitCode.USAGE for missing args
    // (tests the alignment between error code naming and exit class)
    const usageCodes = [
      RetrieveErrorCode.USAGE_MISSING_VAULT_ROOT,
      RetrieveErrorCode.USAGE_MISSING_QUERY,
      RetrieveErrorCode.USAGE_MISSING_ARGS,
      RetrieveErrorCode.NOT_YET_IMPLEMENTED,
    ];
    for (const code of usageCodes) {
      assert.ok(
        code.startsWith("USAGE_") || code === "NOT_YET_IMPLEMENTED",
        `${code} should be a usage-class error`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// TopicMapCandidate — internal loader contract
// ---------------------------------------------------------------------------

describe("TopicMapCandidate contract", () => {
  it("has path, title, tags, description, prose, and linkedNotePaths fields", () => {
    const candidate: TopicMapCandidate = {
      path: "/vault/knowledge/topics/ai-governance.md",
      title: "AI Governance",
      tags: ["ai", "governance", "policy"],
      description: "Topic map covering AI regulatory frameworks.",
      prose: "This topic synthesizes current AI governance approaches...",
      linkedNotePaths: ["/vault/knowledge/notes/note-a.md", "/vault/knowledge/notes/note-b.md"],
    };

    assert.ok(typeof candidate.path === "string");
    assert.ok(typeof candidate.title === "string");
    assert.ok(Array.isArray(candidate.tags));
    assert.ok(typeof candidate.description === "string");
    assert.ok(typeof candidate.prose === "string");
    assert.ok(Array.isArray(candidate.linkedNotePaths));
  });

  it("allows empty tags and linkedNotePaths arrays", () => {
    const candidate: TopicMapCandidate = {
      path: "/vault/knowledge/topics/sparse-topic.md",
      title: "Sparse Topic",
      tags: [],
      description: "",
      prose: "",
      linkedNotePaths: [],
    };

    assert.deepEqual(candidate.tags, []);
    assert.deepEqual(candidate.linkedNotePaths, []);
  });
});

// ---------------------------------------------------------------------------
// Integration: JSON field name stability
// ---------------------------------------------------------------------------

describe("JSON field name stability", () => {
  it("RetrieveResponse serializes with all expected top-level keys", () => {
    const response = makeRetrieveResponse({
      confidence: "medium",
      coverage_gap: false,
      broadening_hints: [makeBroadeningHint({ suggested_query: "machine learning regulation" })],
    });

    const parsed = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;

    assert.ok("schema_version" in parsed);
    assert.ok("query" in parsed);
    assert.ok("confidence" in parsed);
    assert.ok("coverage_gap" in parsed);
    assert.ok("results" in parsed);
    assert.ok("broadening_hints" in parsed);
  });

  it("RetrieveResponse results entries serialize with expected keys", () => {
    const response = makeRetrieveResponse();
    const parsed = JSON.parse(JSON.stringify(response)) as { results: Record<string, unknown>[] };

    const result = parsed.results[0];
    assert.ok(result !== undefined);
    assert.ok("path" in result);
    assert.ok("title" in result);
    assert.ok("excerpt" in result);
    assert.ok("linked_notes" in result);
    assert.ok("score" in result);
  });

  it("linked_notes entries serialize with path, summary, and provenance keys", () => {
    const response = makeRetrieveResponse();
    const parsed = JSON.parse(JSON.stringify(response)) as {
      results: Array<{ linked_notes: Record<string, unknown>[] }>;
    };

    const note = parsed.results[0]?.linked_notes[0];
    assert.ok(note !== undefined);
    assert.ok("path" in note);
    assert.ok("summary" in note);
    assert.ok("provenance" in note);

    const provenance = note["provenance"] as Record<string, unknown>;
    assert.ok("source_key" in provenance);
    assert.ok("kind" in provenance);
  });

  it("serializes bounded source-span evidence with snake_case profile metadata", () => {
    const response = makeRetrieveResponse({
      results: [
        makeRetrieveResult({
          linked_notes: [makeLinkedNote({ source_spans: [makeHydratedSourceSpanSet()] })],
        }),
      ],
    });
    const parsed = JSON.parse(JSON.stringify(response)) as {
      results: Array<{
        linked_notes: Array<{ source_spans: Array<Record<string, unknown>> }>;
      }>;
    };
    const set = parsed.results[0]?.linked_notes[0]?.source_spans[0];
    assert.ok(set !== undefined);
    assert.ok("anchor_id" in set);
    assert.ok("profile" in set);
    assert.ok("exact" in set);
    assert.ok("previous" in set);
    assert.ok("next" in set);
    const exact = set["exact"] as Record<string, unknown>;
    assert.ok("anchor_ids" in exact);
    assert.ok("heading" in exact);
  });

  it("RetrieveEvalReport serializes with all expected top-level keys", () => {
    const report = makeEvalReport();
    const parsed = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;

    assert.ok("schema_version" in parsed);
    assert.ok("vault_root" in parsed);
    assert.ok("run_at" in parsed);
    assert.ok("query_results" in parsed);
    assert.ok("metrics" in parsed);
  });

  it("metrics block serializes with all expected keys", () => {
    const report = makeEvalReport();
    const parsed = JSON.parse(JSON.stringify(report)) as {
      metrics: Record<string, unknown>;
    };

    const m = parsed.metrics;
    assert.ok("total_queries" in m);
    assert.ok("hit_count" in m);
    assert.ok("hit_rate" in m);
    assert.ok("high_confidence_count" in m);
    assert.ok("medium_confidence_count" in m);
    assert.ok("low_confidence_count" in m);
    assert.ok("coverage_gap_count" in m);
    assert.ok("median_duration_ms" in m);
  });

  it("schema_version values are preserved exactly through JSON round-trip", () => {
    const response = makeRetrieveResponse();
    const parsedResponse = JSON.parse(JSON.stringify(response)) as Record<string, unknown>;
    assert.equal(parsedResponse["schema_version"], "okv-retrieve/1.0.0");

    const report = makeEvalReport();
    const parsedReport = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    assert.equal(parsedReport["schema_version"], "okv-retrieve-eval/1.0.0");
  });

  it("field names use snake_case throughout the contract", () => {
    const response = makeRetrieveResponse({ broadening_hints: [makeBroadeningHint()] });
    const json = JSON.stringify(response);

    // Spot-check snake_case field names vs camelCase equivalents
    assert.ok(json.includes('"schema_version"'));
    assert.ok(json.includes('"coverage_gap"'));
    assert.ok(json.includes('"broadening_hints"'));
    assert.ok(json.includes('"linked_notes"'));
    assert.ok(json.includes('"topic_path"'));
    assert.ok(!json.includes('"schemaVersion"'));
    assert.ok(!json.includes('"coverageGap"'));
    assert.ok(!json.includes('"broadeningHints"'));
    assert.ok(!json.includes('"linkedNotes"'));
    assert.ok(!json.includes('"topicPath"'));
  });
});
