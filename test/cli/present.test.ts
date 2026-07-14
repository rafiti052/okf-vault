import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExitCode, helpText, type CliResult, type DispatchOutcome } from "../../dist/cli/cli.js";
import { presentHuman, type PresentOptions } from "../../dist/cli/present.js";

const noColorOptions: PresentOptions = {
  mode: "human",
  noColor: true,
  env: { NO_COLOR: "1" },
};

function captureHuman(outcome: DispatchOutcome, options: PresentOptions = noColorOptions): string {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    presentHuman(outcome, options);
  } finally {
    process.stdout.write = original;
  }

  return chunks.join("");
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

function ok(
  command: string,
  data: Record<string, unknown>,
  exitCode: DispatchOutcome["exitCode"] = ExitCode.SUCCESS,
) {
  return {
    exitCode,
    result: { status: "ok", command, data },
  } satisfies DispatchOutcome;
}

const validateSuccess = ok("validate", {
  status: "pass",
  summary: "Quality gate passed.",
  checks: {
    committed_notes: {
      status: "pass",
      summary: "Committed notes passed.",
      issues: [],
    },
  },
});

const validateFailure = ok(
  "validate",
  {
    status: "fail",
    summary: "Quality gate failed with 2 issue(s).",
    checks: {
      committed_notes: {
        status: "pass",
        summary: "Committed notes passed.",
        issues: [],
      },
      manifest: {
        status: "fail",
        summary: "Manifest has drift.",
        issues: [
          {
            code: "MANIFEST_DRIFT",
            message: "On-disk note 'notes/orphan.md' has no committed manifest record.",
            path: "notes/orphan.md",
          },
        ],
      },
    },
  },
  ExitCode.VALIDATION,
);

const usageError: DispatchOutcome = {
  exitCode: ExitCode.USAGE,
  result: {
    status: "error",
    command: "usage",
    code: "USAGE_MISSING_COMMAND",
    message: "A command is required.",
  },
  diagnostic: "Missing command.",
};

describe("presentHuman", () => {
  const ansiEscape = String.fromCharCode(27);

  it("renders validate success with a table header and status glyph", () => {
    const output = captureHuman(validateSuccess);

    assert.match(output, /│ check\s+│ status │ detail/);
    assert.match(output, /✓ pass/);
    assert.match(output, /→ next:/);
  });

  it("styles CliError headers when color is enabled and strips color with NO_COLOR", () => {
    const colored = captureHuman(usageError, {
      mode: "human",
      forceColor: true,
      env: { FORCE_COLOR: "1" },
    });
    assert.equal(colored.includes(`${ansiEscape}[31m`), true);

    const plain = captureHuman(usageError, noColorOptions);
    assert.equal(plain.includes(ansiEscape), false);
    assert.match(plain, /✗ usage/);
  });

  it("uses ASCII glyphs and borders when TERM=dumb", () => {
    const output = captureHuman(usageError, {
      mode: "human",
      noColor: true,
      env: { NO_COLOR: "1", TERM: "dumb" },
    });

    assert.match(output, /x usage/);
    assert.match(output, /-> next:/);
    assert.doesNotMatch(output, /[✓✗→╭╮╰╯┌┐└┘]/u);
  });

  it("ends every reserved formatter with a next-step line", () => {
    const outcomes: DispatchOutcome[] = [
      validateSuccess,
      ok("validate-staged", {
        report: { status: "pass", summary: "Staged notes passed.", issues: [] },
      }),
      ok("validate-graph", {
        report: { status: "pass", summary: "Graph passed.", issues: [] },
      }),
      ok("validate-proposals", {
        report: { status: "pass", summary: "Proposals passed.", issues: [] },
      }),
      ok("init", { vault_root: "/tmp/vault", committed: true, revision: "rev" }),
      ok("inspect", { source_key: "local:/tmp/a.md", outcome: "new", revision: "rev" }),
      ok("commit", {
        run_id: "run-1",
        source_key: "local:/tmp/a.md",
        note_path: "notes/a.md",
        commit: "abc1234",
      }),
      ok("recover", { recovered: true, run_id: "run-1", restored_paths: ["notes/a.md"] }),
      ok("uninstall", { removed: ["okv"], skipped: ["knowledge"] }),
      ok("dossier", { count: 0, dossiers: [] }),
      ok("visualize", { invoked: true, exit_code: 0, stdout: "", stderr: "" }),
      ok("help", { text: helpText() }),
      ok("version", { version: "0.1.0" }),
      ok("retrieve", {
        schema_version: "okv-retrieve/1.0.0",
        query: "test query",
        confidence: "high",
        coverage_gap: false,
        results: [
          {
            path: "/vault/topics/strategy.md",
            title: "Strategy",
            excerpt: "Strategy notes.",
            linked_notes: [],
            score: 5,
          },
        ],
        broadening_hints: [],
      }),
      usageError,
    ];

    for (const outcome of outcomes) {
      const output = captureHuman(outcome).trimEnd();
      assert.match(output.split("\n").at(-1) ?? "", /^→ next: /, outcome.result?.command);
    }
  });

  it("does not mutate the input CliResult", () => {
    const result: CliResult = {
      status: "ok",
      command: "inspect",
      data: {
        source_key: "local:/tmp/a.md",
        outcome: "already_processed",
        revision: "rev",
        record: { source_key: "local:/tmp/a.md", status: "committed" },
      },
    };
    const outcome: DispatchOutcome = { exitCode: ExitCode.SUCCESS, result };
    const before = JSON.stringify(result);

    deepFreeze(outcome);
    captureHuman(outcome);

    assert.equal(JSON.stringify(result), before);
  });

  it("renders help and version without JSON lines", () => {
    const help = captureHuman(ok("help", { text: helpText() }));
    const version = captureHuman(ok("version", { version: "0.1.0" }));

    assert.match(help, /Usage:/);
    assert.match(version, /version: 0\.1\.0/);
    assert.doesNotMatch(`${help}${version}`, /^\{/m);
    assert.doesNotMatch(`${help}${version}`, /"status"/);
  });

  it("matches the validate failure NO_COLOR snapshot", () => {
    const output = captureHuman(validateFailure);

    assert.equal(
      output,
      `╭────────────╮
│ ✗ validate │
╰────────────╯

┌──────────────────┬────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ check            │ status │ detail                                                                            │
├──────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ committed notes  │ ✓ pass │ Committed notes passed.                                                           │
├──────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ manifest         │ ✗ fail │ Manifest has drift.                                                               │
├──────────────────┼────────┼───────────────────────────────────────────────────────────────────────────────────┤
│   MANIFEST_DRIFT │ ✗      │ notes/orphan.md: On-disk note 'notes/orphan.md' has no committed manifest record. │
└──────────────────┴────────┴───────────────────────────────────────────────────────────────────────────────────┘

→ next: fix the reported validation issues, then retry or skip with a reason.
`,
    );
  });

  it("renders representative init and usage error outcomes", () => {
    const init = captureHuman(
      ok("init", {
        vault_root: "/tmp/vault",
        idempotent: false,
        committed: true,
        commit: "abc1234",
        revision: "rev",
      }),
    );
    const error = captureHuman(usageError);

    assert.match(init, /vault root/);
    assert.match(init, /run validate to confirm the vault is ready/);
    assert.match(error, /A command is required/);
    assert.doesNotMatch(error, /Missing command/);
  });

  it("renders uninstall dry-run removed and skipped table columns", () => {
    const output = captureHuman(
      ok("uninstall", {
        dry_run: true,
        removed: [{ label: "Cursor okv-ingest", path: ".cursor/skills/okv-ingest" }],
        skipped: [{ label: "global okv bin", reason: "not installed" }],
      }),
      { mode: "human", noColor: true, env: { NO_COLOR: "1", TERM: "dumb" } },
    );

    assert.match(output, /artifact\s+\| removed \| skipped \| detail/);
    assert.match(output, /Cursor okv-ingest\s+\| ok\s+\| -/);
    assert.match(output, /global okv bin\s+\| -\s+\| ok\s+\| not installed/);
  });

  it("renders retrieve query response with confidence and topic title", () => {
    const output = captureHuman(
      ok("retrieve", {
        schema_version: "okv-retrieve/1.0.0",
        query: "business strategy planning",
        confidence: "high",
        coverage_gap: false,
        results: [
          {
            path: "/vault/topics/strategy.md",
            title: "Strategy",
            excerpt: "Strategy covers business planning and competitive positioning.",
            linked_notes: [],
            score: 10,
          },
        ],
        broadening_hints: [],
      }),
      noColorOptions,
    );

    assert.match(output, /Strategy/);
    assert.match(output, /high/);
    assert.match(output, /→ next:/);
  });

  it("renders retrieve eval report with hit rate", () => {
    const output = captureHuman(
      ok("retrieve", {
        schema_version: "okv-retrieve-eval/1.0.0",
        vault_root: "/vault",
        run_at: "2026-06-28T10:00:00.000Z",
        query_results: [
          {
            query: "business strategy",
            top_result_path: "/vault/topics/strategy.md",
            confidence: "high",
            hit: true,
            coverage_gap: false,
            top_score: 8,
            duration_ms: 2,
          },
          {
            query: "software architecture",
            top_result_path: "/vault/topics/engineering.md",
            confidence: "medium",
            hit: false,
            coverage_gap: false,
            top_score: 3,
            duration_ms: 1,
          },
        ],
        metrics: {
          total_queries: 2,
          hit_count: 1,
          hit_rate: 0.5,
          high_confidence_count: 1,
          medium_confidence_count: 1,
          low_confidence_count: 0,
          coverage_gap_count: 0,
          median_duration_ms: 1.5,
        },
      }),
      noColorOptions,
    );

    assert.match(output, /50%/);
    assert.match(output, /hit rate/);
    assert.match(output, /→ next:/);
  });

  it("renders retrieve coverage_gap response with coverage gap message", () => {
    const output = captureHuman(
      ok("retrieve", {
        schema_version: "okv-retrieve/1.0.0",
        query: "quantum entanglement in medieval cooking",
        confidence: "low",
        coverage_gap: true,
        results: [],
        broadening_hints: [
          {
            topic_path: "/vault/topics/strategy.md",
            reason: "Adjacent topic: Strategy",
            suggested_query: "business planning",
          },
        ],
      }),
      noColorOptions,
    );

    assert.match(output, /No strong topic match/);
    assert.match(output, /→ next:/);
  });
});
