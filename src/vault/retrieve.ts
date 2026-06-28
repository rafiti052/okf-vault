import * as fs from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type DispatchOutcome, ExitCode, failure } from "../cli/cli.js";
import { MANIFEST_RELATIVE_PATH, TOPICS_INDEX_PATH } from "./constants.js";

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
// Topic candidate loader — Task 04
// ---------------------------------------------------------------------------

/**
 * Raw file content entry produced by the topic-map candidate loader.
 * Contains only the absolute path and unparsed markdown content.
 * Field extraction and scoring are handled by later pipeline stages.
 */
export interface RawTopicFile {
  /** Absolute path to the topic map markdown file. */
  path: string;
  /** Raw markdown content of the file. */
  content: string;
}

/**
 * The filename of the managed topics index, excluded from candidate loading.
 * Matches the basename component of TOPICS_INDEX_PATH ("index.md").
 */
const TOPICS_INDEX_BASENAME = basename(TOPICS_INDEX_PATH);

/**
 * Load raw topic map candidate files from `<vaultRoot>/topics/`.
 *
 * Rules:
 * - Only `.md` files are included.
 * - `index.md` (the managed topics index) is excluded.
 * - Candidates are returned in deterministic ascending lexicographic order
 *   by filename so ranking tests stay stable across runs.
 * - Returns an empty array when the `topics/` directory does not exist or
 *   contains no eligible files — callers decide whether to surface an error.
 *
 * This function is the replaceable loader seam described in ADR-003: it
 * performs only filesystem enumeration and raw content reads, with no
 * field parsing or scoring.
 *
 * @param vaultRoot - Absolute path to the vault root directory.
 * @returns Sorted array of raw topic file entries.
 */
export function loadTopicCandidateFiles(vaultRoot: string): RawTopicFile[] {
  const topicsDir = join(vaultRoot, "topics");

  if (!fs.existsSync(topicsDir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = fs.readdirSync(topicsDir);
  } catch {
    return [];
  }

  const candidates: RawTopicFile[] = [];

  for (const entry of entries) {
    // Exclude non-markdown files.
    if (extname(entry) !== ".md") continue;
    // Exclude the managed topics index.
    if (basename(entry) === TOPICS_INDEX_BASENAME) continue;

    const filePath = join(topicsDir, entry);

    // Skip directories that happen to end in .md (unlikely but safe).
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    candidates.push({ path: filePath, content });
  }

  // Deterministic ascending order by filename (not full path) so results
  // are stable regardless of the vault root location.
  candidates.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));

  return candidates;
}

// ---------------------------------------------------------------------------
// Topic candidate parser — Task 05
// ---------------------------------------------------------------------------

/** Pattern matching YAML frontmatter delimiters at the start of a markdown file. */
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u;

/** Pattern matching wikilinks of the form [[path]] or [[path|alias]]. */
const WIKILINK_PATTERN = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/gu;

/**
 * Resolve a wikilink path to an absolute filesystem path.
 *
 * Rules:
 * - If the link already has an extension, treat it as-is.
 * - If the link lacks an extension, append `.md`.
 * - Resolve relative to the `topics/` directory that contains the topic map.
 *
 * @param link - Raw wikilink target (e.g. "notes/my-note" or "my-note.md").
 * @param topicDir - Absolute path to the directory containing the topic map.
 * @returns Absolute path to the linked file.
 */
function resolveWikilink(link: string, topicDir: string): string {
  const normalized = link.trim();
  const withExt = extname(normalized) === "" ? `${normalized}.md` : normalized;
  return resolve(join(topicDir, withExt));
}

/**
 * Parse a raw topic map file into a normalized `TopicMapCandidate`.
 *
 * Extraction rules:
 * - **title**: `frontmatter.title` (string) → first `# Heading` in body → empty string.
 * - **tags**: `frontmatter.tags` (string array) → empty array when absent or malformed.
 * - **description**: `frontmatter.description` (string) → empty string when absent.
 * - **prose**: Full markdown body after the frontmatter block (including all sections).
 *   Used verbatim for lexical scoring; does not strip the `## Notas neste tópico` section
 *   so that linked-note anchors contribute to the prose score.
 * - **linkedNotePaths**: Wikilinks (`[[…]]`) extracted from the entire body, resolved to
 *   absolute paths relative to the topic map's directory.
 *
 * This function is intentionally tolerant: a missing frontmatter block, unparseable YAML,
 * or absent optional fields all produce deterministic empty values rather than errors.
 *
 * @param raw - Raw topic map file entry from `loadTopicCandidateFiles`.
 * @returns Normalized candidate ready for the scoring pipeline.
 */
export function parseTopicCandidateFile(raw: RawTopicFile): TopicMapCandidate {
  const match = FRONTMATTER_PATTERN.exec(raw.content);

  // When there is no frontmatter block, treat the entire content as prose.
  if (match === null) {
    return {
      path: raw.path,
      title: extractFirstHeading(raw.content) ?? "",
      tags: [],
      description: "",
      prose: raw.content,
      linkedNotePaths: extractWikilinks(raw.content, dirname(raw.path)),
    };
  }

  const yamlRaw = match[1] ?? "";
  const body = match[2] ?? "";

  let fm: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(yamlRaw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // Unparseable frontmatter — treat as empty; use body for title fallback.
  }

  const title = extractStringField(fm, "title") ?? extractFirstHeading(body) ?? "";
  const tags = extractStringArrayField(fm, "tags");
  const description = extractStringField(fm, "description") ?? "";

  return {
    path: raw.path,
    title,
    tags,
    description,
    prose: body,
    linkedNotePaths: extractWikilinks(body, dirname(raw.path)),
  };
}

/**
 * Extract the text of the first `# Heading` found in a markdown string.
 * Returns `undefined` when no ATX heading is present.
 */
function extractFirstHeading(text: string): string | undefined {
  for (const line of text.split(/\r?\n/u)) {
    const m = /^#\s+(.+)$/u.exec(line.trim());
    if (m !== null) {
      return m[1]?.trim() ?? undefined;
    }
  }
  return undefined;
}

/**
 * Extract a string field from a frontmatter record.
 * Returns `undefined` when the field is absent or not a string.
 */
function extractStringField(fm: Record<string, unknown>, key: string): string | undefined {
  const value = fm[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract a string-array field from a frontmatter record.
 * Returns an empty array when the field is absent, not an array, or contains non-string entries.
 * Non-string entries are coerced to strings to tolerate YAML scalar variants.
 */
function extractStringArrayField(fm: Record<string, unknown>, key: string): string[] {
  const value = fm[key];
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown) => (typeof item === "string" ? item : String(item)))
    .filter((item: string) => item.length > 0);
}

/**
 * Extract all wikilink targets from a markdown string and resolve them to absolute paths.
 *
 * @param text - Raw markdown content to scan.
 * @param topicDir - Absolute directory path of the topic map (used for resolution).
 * @returns Deduplicated list of absolute paths, in first-occurrence order.
 */
function extractWikilinks(text: string, topicDir: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const m of text.matchAll(WIKILINK_PATTERN)) {
    const link = m[1];
    if (link === undefined || link.trim().length === 0) continue;
    const abs = resolveWikilink(link, topicDir);
    if (!seen.has(abs)) {
      seen.add(abs);
      result.push(abs);
    }
  }
  return result;
}

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
