import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure } from "../cli/cli.js";
import { MANIFEST_RELATIVE_PATH } from "./constants.js";

// ---------------------------------------------------------------------------
// Retrieval result contract — Task 03
// ---------------------------------------------------------------------------

/** Schema version string for the RetrieveResponse envelope. */
export const RETRIEVE_SCHEMA_VERSION = "okv-retrieve/1.0.0" as const;

/** Schema version string for the RetrieveEvalReport envelope. */
export const RETRIEVE_EVAL_SCHEMA_VERSION = "okv-retrieve-eval/1.0.0" as const;

/**
 * In-memory representation of a parsed topic map.
 * Not persisted; produced by the candidate loader (Task 04/05).
 */
export interface TopicMapCandidate {
  /** Absolute path to the topic map file. */
  path: string;
  /** Title extracted from frontmatter or first heading. */
  title: string;
  /** Tags extracted from frontmatter. */
  tags: string[];
  /** Description field from frontmatter. */
  description: string;
  /** Synthesized prose body of the topic map. */
  prose: string;
  /** Absolute paths of notes linked in the topic map. */
  linkedNotePaths: string[];
}

/**
 * Provenance metadata for a linked note.
 * Drawn from manifest records where available.
 */
export interface NoteProvenance {
  /** Manifest source_key for the note, or empty string when unavailable. */
  source_key: string;
  /** Manifest kind for the note (e.g. "granola"), or empty string when unavailable. */
  kind: string;
}

/**
 * A linked note entry inside a RetrieveResult.
 */
export interface LinkedNote {
  /** Absolute path to the note file. */
  path: string;
  /** Bounded summary extracted from the note (<=512 chars). */
  summary: string;
  /** Manifest-derived provenance for the note. */
  provenance: NoteProvenance;
}

/**
 * A single matched topic map within a RetrieveResponse.
 */
export interface RetrieveResult {
  /** Absolute path to the matched topic map file. */
  path: string;
  /** Title of the matched topic map. */
  title: string;
  /** Bounded prose excerpt from the topic map (<=512 chars). */
  excerpt: string;
  /** Linked notes hydrated from the topic map, filtered to committed manifest records. */
  linked_notes: LinkedNote[];
  /** Raw lexical score from the scorer; present for calibration. */
  score: number;
}

/**
 * A broadening hint returned when confidence is medium or low.
 */
export interface BroadeningHint {
  /** Absolute path to an adjacent topic map. */
  topic_path: string;
  /** Human-readable reason this hint was generated. */
  reason: string;
  /** Optional reformulated query derived from the matched topic's tag vocabulary. */
  suggested_query?: string;
}

/**
 * Stable machine-readable retrieval response.
 * This is the primary contract returned by `okv retrieve`.
 * The schema_version field allows future breaking changes without ambiguity.
 */
export interface RetrieveResponse {
  /** Fixed schema version identifying this response shape. */
  schema_version: typeof RETRIEVE_SCHEMA_VERSION;
  /** The original query string submitted by the caller. */
  query: string;
  /** Confidence tier computed from score distribution. */
  confidence: "high" | "medium" | "low";
  /**
   * True when the best-scoring topic map falls below the minimum confidence
   * threshold. Signals to agents that the vault has no strong thematic coverage
   * for this query.
   */
  coverage_gap: boolean;
  /** Ranked topic map results. Contains at least one entry on non-gap responses. */
  results: RetrieveResult[];
  /**
   * Adjacent topic paths and optional reformulations to help the agent follow up
   * when confidence is medium or low.
   */
  broadening_hints: BroadeningHint[];
}

// ---------------------------------------------------------------------------
// Eval contract — Task 03
// ---------------------------------------------------------------------------

/**
 * A single entry in the repo-owned eval fixture set.
 * Stored under test/fixtures/ and version-controlled.
 */
export interface RetrieveEvalCase {
  /** Natural-language query to evaluate. */
  query: string;
  /**
   * Topic map paths expected to appear in the top result(s).
   * Relative to the vault root or absolute; resolvers normalise these.
   */
  expected_topic_paths: string[];
  /** Optional human note for calibration or triage. */
  note?: string;
}

/**
 * Per-query outcome inside a RetrieveEvalReport.
 */
export interface RetrieveEvalQueryResult {
  /** The query that was evaluated. */
  query: string;
  /** Top-ranked topic map path returned for this query (or null on coverage gap). */
  top_result_path: string | null;
  /** Confidence tier assigned to the top result. */
  confidence: "high" | "medium" | "low";
  /** Whether the expected topic map appeared in the returned results. */
  hit: boolean;
  /** Whether the query triggered coverage_gap: true. */
  coverage_gap: boolean;
  /** Raw score of the top result, or 0 on coverage gap. */
  top_score: number;
  /** Duration in milliseconds for this query's retrieval pass. */
  duration_ms: number;
}

/**
 * Aggregate metrics block within a RetrieveEvalReport.
 */
export interface RetrieveEvalMetrics {
  /** Total number of eval queries executed. */
  total_queries: number;
  /** Number of queries where the expected topic map appeared in results. */
  hit_count: number;
  /** Top-1 hit rate as a fraction (0-1). */
  hit_rate: number;
  /** Number of queries with confidence === "high". */
  high_confidence_count: number;
  /** Number of queries with confidence === "medium". */
  medium_confidence_count: number;
  /** Number of queries with confidence === "low". */
  low_confidence_count: number;
  /** Number of queries that triggered coverage_gap: true. */
  coverage_gap_count: number;
  /** Median retrieval duration across all queries, in milliseconds. */
  median_duration_ms: number;
}

/**
 * Stable machine-readable report produced by `okv retrieve --eval`.
 * Suitable for CI assertion and human inspection alike.
 */
export interface RetrieveEvalReport {
  /** Fixed schema version identifying this report shape. */
  schema_version: typeof RETRIEVE_EVAL_SCHEMA_VERSION;
  /** Absolute path to the vault root evaluated. */
  vault_root: string;
  /** ISO 8601 timestamp when the eval run was started. */
  run_at: string;
  /** Per-query outcomes. */
  query_results: RetrieveEvalQueryResult[];
  /** Aggregate metrics computed over all query_results. */
  metrics: RetrieveEvalMetrics;
}

// ---------------------------------------------------------------------------
// Retrieval-specific error codes — Task 03
// ---------------------------------------------------------------------------

/**
 * Stable error codes emitted by the retrieval handler.
 * Each maps to a CliError.code value and has a defined exit class.
 *
 * Exit class mapping:
 *   USAGE_*       -> ExitCode.USAGE (2)
 *   VAULT_*       -> ExitCode.VALIDATION (3) for vault structure failures
 *   RETRIEVE_*    -> ExitCode.VALIDATION (3) for eval threshold failures
 *   UNEXPECTED_*  -> ExitCode.UNEXPECTED (1)
 */
export const RetrieveErrorCode = {
  // --- usage failures (exit 2) ---
  /** Vault root was not supplied and cwd is not a valid vault root. */
  USAGE_MISSING_VAULT_ROOT: "USAGE_MISSING_VAULT_ROOT",
  /** Query string was not provided in query mode. */
  USAGE_MISSING_QUERY: "USAGE_MISSING_QUERY",
  /** Command received fewer positional arguments than required. */
  USAGE_MISSING_ARGS: "USAGE_MISSING_ARGS",
  /** Feature or mode is registered but not yet implemented. */
  NOT_YET_IMPLEMENTED: "NOT_YET_IMPLEMENTED",

  // --- vault structure failures (exit 3) ---
  /** The supplied or resolved vault root path does not exist. */
  VAULT_ROOT_NOT_FOUND: "VAULT_ROOT_NOT_FOUND",
  /** The supplied path exists but contains no topics/ directory. */
  VAULT_NO_TOPICS_DIR: "VAULT_NO_TOPICS_DIR",
  /** The vault root contains no topic maps to score. */
  VAULT_NO_TOPIC_MAPS: "VAULT_NO_TOPIC_MAPS",
  /** manifest.json is missing or unreadable in the vault root. */
  VAULT_MANIFEST_MISSING: "VAULT_MANIFEST_MISSING",

  // --- eval threshold failures (exit 3) ---
  /** Eval completed but the hit rate is below the required baseline. */
  RETRIEVE_EVAL_BELOW_THRESHOLD: "RETRIEVE_EVAL_BELOW_THRESHOLD",

  // --- unexpected failures (exit 1) ---
  /** An unexpected I/O or parsing error occurred during retrieval. */
  UNEXPECTED_IO_ERROR: "UNEXPECTED_IO_ERROR",
} as const;

export type RetrieveErrorCodeValue =
  (typeof RetrieveErrorCode)[keyof typeof RetrieveErrorCode];

// ---------------------------------------------------------------------------
// Vault root resolution — Task 02
// ---------------------------------------------------------------------------

/**
 * Returns true when the given directory satisfies the vault-root contract:
 * it must contain an initialized manifest at `.okf-vault/manifest.json`.
 */
export function isValidVaultRoot(dir: string): boolean {
  const manifestPath = join(resolve(dir), MANIFEST_RELATIVE_PATH);
  return fs.existsSync(manifestPath);
}

/**
 * Resolve the vault root from a positional argument list using the
 * ADR-006 cwd-fallback policy:
 *
 * - If `positional[0]` is a valid vault root, consume it and return the rest
 *   as `remainder`.
 * - Otherwise fall back to `process.cwd()` when it is itself a valid vault
 *   root and return the full positional list as `remainder`.
 * - Never walks parent directories or reads ambient config.
 *
 * Returns a discriminated union so callers can return the error outcome
 * directly without wrapping.
 */
export function resolveVaultRoot(
  positional: string[],
  getCwd: () => string = () => process.cwd(),
): { ok: true; vaultRoot: string; remainder: string[] } | { ok: false; outcome: DispatchOutcome } {
  if (positional.length > 0) {
    const candidate = positional[0] as string;
    if (isValidVaultRoot(candidate)) {
      return {
        ok: true,
        vaultRoot: resolve(candidate),
        remainder: positional.slice(1),
      };
    }
  }

  const cwd = getCwd();
  if (isValidVaultRoot(cwd)) {
    return { ok: true, vaultRoot: resolve(cwd), remainder: positional };
  }

  return {
    ok: false,
    outcome: {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        RetrieveErrorCode.VAULT_ROOT_NOT_FOUND,
        [
          "Could not determine a valid vault root.",
          "Either pass the vault root as the first argument or run the command",
          "from a directory that is itself an initialized OKV vault root.",
          "  okv retrieve <vault-root> <query>",
          "  okv retrieve <query>          # when cwd is a vault root",
        ].join("\n"),
      ),
      diagnostic:
        "No explicit vault root supplied and cwd is not a valid vault root. " +
        "Parent-directory search is not supported.",
    },
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleRetrieve(
  args: string[],
  getCwd: () => string = () => process.cwd(),
): DispatchOutcome {
  const evalFlag = args.includes("--eval");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (evalFlag) {
    const resolution = resolveVaultRoot(positional, getCwd);
    if (!resolution.ok) return resolution.outcome;
    // Placeholder: eval execution implemented in tasks 13–14
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        RetrieveErrorCode.NOT_YET_IMPLEMENTED,
        "Eval mode is not yet implemented.",
      ),
    };
  }

  // query mode: okv retrieve <vault-root> <query> or okv retrieve <query>
  if (positional.length === 0) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        RetrieveErrorCode.USAGE_MISSING_ARGS,
        "Usage: okv retrieve <vault-root> <query>  or  okv retrieve <query>",
      ),
      diagnostic: "Missing required arguments for retrieve.",
    };
  }

  const resolution = resolveVaultRoot(positional, getCwd);
  if (!resolution.ok) return resolution.outcome;

  const { vaultRoot, remainder } = resolution;

  if (remainder.length === 0) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "retrieve",
        RetrieveErrorCode.USAGE_MISSING_QUERY,
        "Usage: okv retrieve <vault-root> <query>  or  okv retrieve <query>",
      ),
      diagnostic: `Vault root resolved to ${vaultRoot} but no query was provided.`,
    };
  }

  // Placeholder: retrieval execution implemented in tasks 04–11
  return {
    exitCode: ExitCode.USAGE,
    result: failure(
      "retrieve",
      RetrieveErrorCode.NOT_YET_IMPLEMENTED,
      "Retrieval is not yet implemented.",
    ),
  };
}
