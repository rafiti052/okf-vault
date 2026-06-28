import * as fs from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import { MANIFEST_RELATIVE_PATH, TOPICS_INDEX_PATH } from "./constants.js";
import { loadManifest } from "./manifest.js";

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
// Weighted lexical scoring engine — Task 06
// ---------------------------------------------------------------------------

/**
 * Field weights for lexical scoring.
 * Higher weight means a token match in that field contributes more to the score.
 * Weight order: title > tags > description > prose (per ADR-004).
 */
const FIELD_WEIGHTS = {
  title: 10,
  tags: 8,
  description: 4,
  prose: 1,
} as const;

/**
 * Normalize a text string into a sorted set of lowercase tokens.
 *
 * Normalization rules:
 * - Decompose Unicode characters (NFD) so diacritics are stripped.
 * - Remove non-ASCII characters (strips diacritic combining marks).
 * - Lowercase all characters.
 * - Split on whitespace, punctuation, and common separators.
 * - Filter out empty tokens and very short noise tokens (length < 2).
 *
 * This ensures bilingual content (Portuguese/English with accented characters)
 * normalizes consistently with unaccented query tokens.
 *
 * @param text - Raw input string.
 * @returns Array of normalized tokens (order preserved, may contain duplicates).
 */
export function tokenize(text: string): string[] {
  return (
    text
      // Decompose diacritics (NFD) then strip combining marks
      .normalize("NFD")
      .replace(/[̀-ͯ]/gu, "")
      // Lowercase
      .toLowerCase()
      // Split on any non-alphanumeric character
      .split(/[^a-z0-9]+/u)
      // Filter out empty tokens
      .filter((t) => t.length >= 2)
  );
}

/**
 * Count how many query tokens appear in the candidate field token set.
 *
 * @param queryTokens - Pre-normalized query tokens.
 * @param fieldTokens - Pre-normalized field tokens.
 * @returns Number of matching tokens (counting duplicates in query).
 */
function countMatches(queryTokens: string[], fieldTokens: Set<string>): number {
  let count = 0;
  for (const token of queryTokens) {
    if (fieldTokens.has(token)) {
      count++;
    }
  }
  return count;
}

/**
 * Compute a deterministic weighted lexical relevance score for a single
 * topic-map candidate against a normalized query.
 *
 * Scoring algorithm:
 * - Tokenize the query and each candidate field using the shared `tokenize` helper.
 * - For each query token, check if it appears in each field's token set.
 * - Multiply per-field match count by that field's weight.
 * - Sum contributions across all fields.
 *
 * The score is a non-negative integer. Higher is more relevant.
 * A score of 0 means no query tokens matched any candidate field.
 *
 * @param query - Natural-language query string from the caller.
 * @param candidate - Normalized topic-map candidate to score.
 * @returns Numeric relevance score (0 = no match).
 */
export function scoreCandidate(query: string, candidate: TopicMapCandidate): number {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return 0;

  const titleTokens = new Set(tokenize(candidate.title));
  const tagsTokens = new Set(tokenize(candidate.tags.join(" ")));
  const descriptionTokens = new Set(tokenize(candidate.description));
  const proseTokens = new Set(tokenize(candidate.prose));

  const titleScore = countMatches(queryTokens, titleTokens) * FIELD_WEIGHTS.title;
  const tagsScore = countMatches(queryTokens, tagsTokens) * FIELD_WEIGHTS.tags;
  const descriptionScore = countMatches(queryTokens, descriptionTokens) * FIELD_WEIGHTS.description;
  const proseScore = countMatches(queryTokens, proseTokens) * FIELD_WEIGHTS.prose;

  return titleScore + tagsScore + descriptionScore + proseScore;
}

/**
 * Score all candidates against a query and return them sorted by score descending.
 * Ties are broken by candidate path (ascending) for determinism.
 *
 * @param query - Natural-language query string.
 * @param candidates - Array of normalized topic-map candidates.
 * @returns Array of `{ candidate, score }` records sorted by score descending.
 */
export function rankCandidates(
  query: string,
  candidates: TopicMapCandidate[],
): Array<{ candidate: TopicMapCandidate; score: number }> {
  const scored = candidates.map((candidate) => ({
    candidate,
    score: scoreCandidate(query, candidate),
  }));

  // Stable descending sort: higher score first; ties broken by path ascending.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.candidate.path.localeCompare(b.candidate.path);
  });

  return scored;
}

// ---------------------------------------------------------------------------
// Confidence tier and multi-result selection — Task 07
// ---------------------------------------------------------------------------

/**
 * Thresholds governing confidence tier assignment and close-score expansion.
 *
 * All values are implementation constants calibrated through the repo-owned
 * eval fixture set (ADR-004). They are not exposed as CLI flags in V1.
 *
 * CONFIDENCE_HIGH_DOMINANCE_RATIO:
 *   The top score must be at least this multiple of the median score to emit
 *   `high` confidence. A value of 2.0 means the top score must be twice the
 *   median — ensures the winner clearly outranks the field.
 *
 * CONFIDENCE_LOW_MINIMUM_THRESHOLD:
 *   Absolute minimum top score below which `low` is always emitted regardless
 *   of distribution. A score of 0 means nothing matched at all.
 *
 * CLOSE_SCORE_WINDOW:
 *   Fraction of the top score used to define the close-score window.
 *   A value of 0.8 means any candidate scoring >= topScore * 0.8 is included
 *   as a secondary result alongside the top result.
 *
 * MAX_RESULTS:
 *   Hard cap on the number of candidates returned. Prevents unbounded
 *   expansion when many candidates cluster near the top score.
 */
const CONFIDENCE_HIGH_DOMINANCE_RATIO = 2.0;
const CONFIDENCE_LOW_MINIMUM_THRESHOLD = 1;
const CLOSE_SCORE_WINDOW = 0.8;
const MAX_RESULTS = 5;

/**
 * Assign a confidence tier to a retrieval result set.
 *
 * Algorithm (per ADR-004 — uses the full score distribution, not only the top):
 * 1. If the top score is below `CONFIDENCE_LOW_MINIMUM_THRESHOLD`, emit `low`.
 * 2. Compute the median of all scores.
 *    - If the median is 0 and the top score is positive, there is a single
 *      strong signal — emit `high`.
 *    - If topScore / median >= CONFIDENCE_HIGH_DOMINANCE_RATIO, emit `high`.
 * 3. Otherwise emit `medium`.
 *
 * @param topScore - The highest score in the ranked list.
 * @param scores   - All scores from the ranked list (must include topScore).
 * @returns Confidence tier string.
 */
export function assignConfidence(
  topScore: number,
  scores: number[],
): "high" | "medium" | "low" {
  if (topScore < CONFIDENCE_LOW_MINIMUM_THRESHOLD) return "low";

  // Compute median of all scores.
  const sorted = [...scores].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] as number)
      : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;

  if (median === 0 || topScore / median >= CONFIDENCE_HIGH_DOMINANCE_RATIO) {
    return "high";
  }

  return "medium";
}

/**
 * Select the final result set from a ranked candidate list.
 *
 * Selection rules (per ADR-004):
 * - Always include the top-ranked candidate (index 0).
 * - Include additional candidates whose score falls within the close-score
 *   window: score >= topScore * CLOSE_SCORE_WINDOW.
 * - Hard-cap the total number of results at MAX_RESULTS.
 * - Preserves the ranked order (deterministic, already sorted by rankCandidates).
 *
 * When the ranked list is empty, returns an empty candidates array with `low`
 * confidence. This is the coverage-gap case.
 *
 * @param ranked - Array of `{ candidate, score }` records sorted descending
 *                 by score (as returned by `rankCandidates`).
 * @returns Object with the selected `candidates` subset and derived `confidence`.
 */
export function selectResults(
  ranked: Array<{ candidate: TopicMapCandidate; score: number }>,
): {
  candidates: Array<{ candidate: TopicMapCandidate; score: number }>;
  confidence: "high" | "medium" | "low";
} {
  if (ranked.length === 0) {
    return { candidates: [], confidence: "low" };
  }

  const topScore = (ranked[0] as { candidate: TopicMapCandidate; score: number }).score;
  const allScores = ranked.map((r) => r.score);
  const confidence = assignConfidence(topScore, allScores);

  const threshold = topScore * CLOSE_SCORE_WINDOW;
  const selected = ranked.filter((r) => r.score >= threshold).slice(0, MAX_RESULTS);

  return { candidates: selected, confidence };
}

// ---------------------------------------------------------------------------
// Broadening hint generation — Task 08
// ---------------------------------------------------------------------------

/**
 * Maximum number of broadening hints returned per response.
 * Keeps hint output bounded and token-economic for agents.
 */
const MAX_HINTS = 5;

/**
 * Maximum number of suggested query reformulations included in hints.
 * Per PRD F4: "up to two suggested follow-up query reformulations".
 */
const MAX_SUGGESTED_QUERIES = 2;

/**
 * Generate broadening hints for medium/low-confidence retrieval responses.
 *
 * Hints are derived from two adjacency signals:
 * 1. Shared-tag adjacency — topic maps that share tags with selected results.
 * 2. Shared linked-note adjacency — topic maps that share linked-note paths.
 *
 * Hint suppression rules:
 * - When confidence === "high" AND coverage_gap === false, return [].
 * - Topic maps already in selected are excluded.
 * - Output is bounded to MAX_HINTS and ordered deterministically.
 * - Each topic map appears at most once.
 */
export function generateBroadeningHints(
  query: string,
  confidence: "high" | "medium" | "low",
  coverage_gap: boolean,
  selected: Array<{ candidate: TopicMapCandidate; score: number }>,
  allCandidates: TopicMapCandidate[],
): BroadeningHint[] {
  if (confidence === "high" && !coverage_gap) return [];

  const selectedPaths = new Set(selected.map((s) => s.candidate.path));
  const selectedTags = new Set<string>();
  const selectedLinkedPaths = new Set<string>();

  for (const { candidate } of selected) {
    for (const tag of candidate.tags) selectedTags.add(tag.toLowerCase());
    for (const p of candidate.linkedNotePaths) selectedLinkedPaths.add(p);
  }

  const queryTokenSet = new Set(tokenize(query));
  const sharedTagHints: BroadeningHint[] = [];
  const sharedNoteHints: BroadeningHint[] = [];
  const hintPaths = new Set<string>();

  for (const candidate of allCandidates) {
    if (selectedPaths.has(candidate.path)) continue;

    const candidateTags = candidate.tags.map((t) => t.toLowerCase());
    const sharedTags = candidateTags.filter((t) => selectedTags.has(t));
    if (sharedTags.length > 0 && !hintPaths.has(candidate.path)) {
      hintPaths.add(candidate.path);
      const tagList = sharedTags.slice(0, 3).join(", ");
      sharedTagHints.push({
        topic_path: candidate.path,
        reason: `Shares tag${sharedTags.length > 1 ? "s" : ""}: ${tagList}`,
      });
      continue;
    }

    const sharedNotes = candidate.linkedNotePaths.filter((p) => selectedLinkedPaths.has(p));
    if (sharedNotes.length > 0 && !hintPaths.has(candidate.path)) {
      hintPaths.add(candidate.path);
      sharedNoteHints.push({
        topic_path: candidate.path,
        reason: `Shares ${sharedNotes.length} linked note${sharedNotes.length > 1 ? "s" : ""} with matched topic`,
      });
    }
  }

  sharedTagHints.sort((a, b) => a.topic_path.localeCompare(b.topic_path));
  sharedNoteHints.sort((a, b) => a.topic_path.localeCompare(b.topic_path));
  const hints = [...sharedTagHints, ...sharedNoteHints].slice(0, MAX_HINTS);

  const suggestedQueryTags: string[] = [];
  for (const { candidate } of selected) {
    for (const tag of candidate.tags) {
      const tagTokens = tokenize(tag);
      const hasOverlap = tagTokens.some((t) => queryTokenSet.has(t));
      if (!hasOverlap) {
        const readable = tag.replace(/[-_]/gu, " ").toLowerCase();
        if (!suggestedQueryTags.includes(readable)) suggestedQueryTags.push(readable);
      }
      if (suggestedQueryTags.length >= MAX_SUGGESTED_QUERIES) break;
    }
    if (suggestedQueryTags.length >= MAX_SUGGESTED_QUERIES) break;
  }

  for (let i = 0; i < Math.min(suggestedQueryTags.length, hints.length); i++) {
    const sq = suggestedQueryTags[i];
    if (sq !== undefined) (hints[i] as BroadeningHint).suggested_query = sq;
  }

  return hints;
}

// ---------------------------------------------------------------------------
// Linked note hydration — Task 09
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters allowed in a linked-note summary.
 * Summaries are truncated at this boundary to keep retrieval responses bounded.
 */
const NOTE_SUMMARY_MAX_CHARS = 512;

/**
 * Extract a bounded summary from raw note content.
 *
 * Extraction rules:
 * - Strip the YAML frontmatter block (--- ... ---) if present.
 * - Skip blank lines and ATX heading lines (# …) at the start of the body.
 * - Collect the first contiguous block of non-blank, non-heading lines as the
 *   summary paragraph.
 * - Truncate the result to NOTE_SUMMARY_MAX_CHARS characters.
 * - Return an empty string when no prose paragraph is found.
 *
 * @param content - Raw file content of the note.
 * @returns Bounded prose summary (≤512 chars).
 */
export function extractNoteSummary(content: string): string {
  // Strip frontmatter block if present.
  let body = content;
  const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u.exec(content);
  if (fmMatch !== null) {
    body = content.slice(fmMatch[0].length);
  }

  const lines = body.split(/\r?\n/u);
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!inParagraph) {
      // Skip blank lines and headings before the first prose paragraph.
      if (trimmed.length === 0 || /^#+\s/u.test(trimmed)) continue;
      // Start collecting the paragraph.
      inParagraph = true;
      paragraphLines.push(trimmed);
    } else {
      // A blank line ends the paragraph.
      if (trimmed.length === 0) break;
      paragraphLines.push(trimmed);
    }
  }

  const summary = paragraphLines.join(" ");
  return summary.length <= NOTE_SUMMARY_MAX_CHARS
    ? summary
    : summary.slice(0, NOTE_SUMMARY_MAX_CHARS);
}

/**
 * Hydrate linked notes for a single topic-map candidate.
 *
 * For each path in `candidate.linkedNotePaths`:
 * - Attempt to read the note file from the filesystem.
 * - Extract a bounded summary (≤512 chars) from the first non-frontmatter
 *   prose paragraph.
 * - Attach empty provenance (`source_key: "", kind: ""`).
 *   Provenance will be filled in Task 10 via manifest lookup.
 * - If the file is missing or unreadable, skip it without aborting the
 *   overall response.
 *
 * Only the paths listed in `candidate.linkedNotePaths` are read; the full
 * vault is never scanned.
 *
 * @param candidate - Selected topic-map candidate whose linked notes to hydrate.
 * @param _vaultRoot - Vault root (reserved for Task 10 manifest lookup).
 * @returns Array of hydrated `LinkedNote` records (may be shorter than
 *          `linkedNotePaths` when files are missing or unreadable).
 */
export function hydrateLinkedNotes(
  candidate: TopicMapCandidate,
  _vaultRoot: string,
): LinkedNote[] {
  const results: LinkedNote[] = [];

  for (const notePath of candidate.linkedNotePaths) {
    let content: string;
    try {
      content = fs.readFileSync(notePath, "utf8");
    } catch {
      // Missing or unreadable — skip deterministically without aborting.
      continue;
    }

    const summary = extractNoteSummary(content);

    results.push({
      path: notePath,
      summary,
      provenance: { source_key: "", kind: "" },
    });
  }

  return results;
}

/**
 * Build a manifest index keyed by absolute note_path for committed records.
 * Used by filterNotesViaManifest to avoid re-loading the manifest per note.
 */
export function buildManifestIndex(
  vaultRoot: string,
): Map<string, { source_key: string; kind: string }> {
  let manifest;
  try {
    manifest = loadManifest(vaultRoot);
  } catch {
    return new Map();
  }

  const index = new Map<string, { source_key: string; kind: string }>();
  for (const record of manifest.sources) {
    if (record.status === "committed" && record.note_path !== undefined) {
      const absPath = resolve(vaultRoot, record.note_path);
      index.set(absPath, { source_key: record.source_key, kind: record.kind });
    }
  }
  return index;
}

/**
 * Filter hydrated notes to committed manifest records and attach provenance.
 * Notes not present in the manifest index (non-committed or unknown) are excluded.
 */
export function filterNotesViaManifest(
  notes: LinkedNote[],
  manifestIndex: Map<string, { source_key: string; kind: string }>,
): LinkedNote[] {
  return notes
    .map((note) => {
      const prov = manifestIndex.get(resolve(note.path));
      if (prov === undefined) return null;
      return { ...note, provenance: prov };
    })
    .filter((n): n is LinkedNote => n !== null);
}

// ---------------------------------------------------------------------------
// Response assembly — Task 11
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters allowed in a topic-map excerpt.
 * Mirrors NOTE_SUMMARY_MAX_CHARS for consistency.
 */
const EXCERPT_MAX_CHARS = 512;

/**
 * Extract a bounded prose excerpt from a topic-map candidate.
 *
 * Uses the same paragraph-extraction rules as `extractNoteSummary`:
 * - Strip frontmatter if present.
 * - Skip blank lines and ATX heading lines.
 * - Collect the first contiguous prose paragraph.
 * - Truncate to EXCERPT_MAX_CHARS.
 *
 * @param candidate - The topic-map candidate to excerpt.
 * @returns Bounded prose excerpt (≤512 chars).
 */
function extractExcerpt(candidate: TopicMapCandidate): string {
  return extractNoteSummary(candidate.prose);
}

/**
 * Assemble the final `RetrieveResponse` from a query, vault root, and
 * pre-loaded topic-map candidates.
 *
 * Pipeline:
 * 1. Rank candidates → select results → derive confidence.
 * 2. Determine `coverage_gap`: true when no candidates were selected OR
 *    the top score is below `CONFIDENCE_LOW_MINIMUM_THRESHOLD`.
 * 3. For each selected candidate: hydrate linked notes, filter via manifest,
 *    build a `RetrieveResult`.
 * 4. Generate broadening hints.
 * 5. Return a fully-shaped `RetrieveResponse`.
 *
 * This function always returns a valid response; coverage gaps are surfaced
 * through the `coverage_gap` field, not process failures.
 *
 * @param query         - Natural-language query string from the caller.
 * @param vaultRoot     - Absolute path to the vault root (used for manifest lookup).
 * @param allCandidates - Pre-parsed topic-map candidates (from the loader pipeline).
 * @returns Stable versioned `RetrieveResponse`.
 */
export function buildRetrieveResponse(
  query: string,
  vaultRoot: string,
  allCandidates: TopicMapCandidate[],
): RetrieveResponse {
  const ranked = rankCandidates(query, allCandidates);
  const { candidates: selected, confidence } = selectResults(ranked);

  // coverage_gap: true when nothing was selected OR the top score is below
  // the minimum threshold (meaning nothing meaningfully matched).
  const topScore =
    selected.length > 0
      ? (selected[0] as { candidate: TopicMapCandidate; score: number }).score
      : 0;
  const coverage_gap = selected.length === 0 || topScore < CONFIDENCE_LOW_MINIMUM_THRESHOLD;

  // Build the manifest index once for all selected candidates.
  const manifestIndex = buildManifestIndex(vaultRoot);

  const results: RetrieveResult[] = selected.map(({ candidate, score }) => {
    const hydrated = hydrateLinkedNotes(candidate, vaultRoot);
    const linked_notes = filterNotesViaManifest(hydrated, manifestIndex);
    const excerpt = extractExcerpt(candidate).slice(0, EXCERPT_MAX_CHARS);
    return {
      path: candidate.path,
      title: candidate.title,
      excerpt,
      linked_notes,
      score,
    };
  });

  const broadening_hints = generateBroadeningHints(
    query,
    confidence,
    coverage_gap,
    selected,
    allCandidates,
  );

  return {
    schema_version: RETRIEVE_SCHEMA_VERSION,
    query,
    confidence,
    coverage_gap,
    results,
    broadening_hints,
  };
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
// Eval runner — Task 13
// ---------------------------------------------------------------------------

/**
 * Default path to the bundled eval fixture file.
 * Resolves correctly from both `src/` (ts-node / vitest) and `dist/` (compiled).
 */
const DEFAULT_EVAL_FIXTURES_PATH = fileURLToPath(
  new URL("../../test/fixtures/retrieve-eval/eval-cases.json", import.meta.url),
);

/**
 * Load eval fixture cases from a JSON file.
 *
 * Validates that the parsed value is an array and that each entry has a
 * non-empty `query` string and a non-empty `expected_topic_paths` array.
 * Throws a descriptive Error when any invariant is violated.
 *
 * @param fixturesPath - Absolute path to the JSON fixture file.
 * @returns Parsed array of RetrieveEvalCase objects.
 */
export function loadEvalFixtures(fixturesPath: string): RetrieveEvalCase[] {
  let raw: string;
  try {
    raw = fs.readFileSync(fixturesPath, "utf8");
  } catch (err) {
    throw new Error(
      `loadEvalFixtures: could not read fixture file at ${fixturesPath}: ${String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `loadEvalFixtures: invalid JSON in fixture file at ${fixturesPath}: ${String(err)}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `loadEvalFixtures: fixture file must contain a JSON array, got ${typeof parsed}`,
    );
  }

  const cases: RetrieveEvalCase[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i] as Record<string, unknown>;
    if (typeof entry.query !== "string" || entry.query.trim() === "") {
      throw new Error(
        `loadEvalFixtures: entry[${i}].query must be a non-empty string`,
      );
    }
    if (
      !Array.isArray(entry.expected_topic_paths) ||
      entry.expected_topic_paths.length === 0
    ) {
      throw new Error(
        `loadEvalFixtures: entry[${i}].expected_topic_paths must be a non-empty array`,
      );
    }
    const evalCase: RetrieveEvalCase = {
      query: entry.query as string,
      expected_topic_paths: entry.expected_topic_paths as string[],
    };
    if (typeof entry.note === "string") {
      evalCase.note = entry.note;
    }
    cases.push(evalCase);
  }

  return cases;
}

/**
 * Compute the median of an array of numbers.
 * Returns 0 for an empty array.
 */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Normalize a topic path for comparison.
 * Strips the vault root prefix and leading separator to produce a
 * vault-relative path (e.g. "topics/strategy.md").
 */
function normalizePath(absPath: string, vaultRoot: string): string {
  // Try to make relative to vaultRoot first.
  const rel = relative(vaultRoot, absPath);
  // If the path is already relative (no leading ../) use it; otherwise basename.
  if (!rel.startsWith("..")) {
    return rel;
  }
  return basename(absPath);
}

/**
 * Run the full eval harness against a vault root.
 *
 * For each fixture case:
 * 1. Load and parse topic candidates from the vault.
 * 2. Call buildRetrieveResponse to score and rank candidates.
 * 3. Compare the top result's vault-relative path against expected_topic_paths.
 * 4. Record per-query outcome with timing.
 *
 * Assembles aggregate metrics and returns a RetrieveEvalReport.
 *
 * @param vaultRoot - Absolute path to the vault root to evaluate.
 * @param fixtures  - Array of eval cases to run.
 * @returns Fully-shaped RetrieveEvalReport.
 */
export function runRetrieveEval(
  vaultRoot: string,
  fixtures: RetrieveEvalCase[],
): RetrieveEvalReport {
  const runAt = new Date().toISOString();

  // Load candidates once; they are the same for every query.
  const rawFiles = loadTopicCandidateFiles(vaultRoot);
  const allCandidates = rawFiles.map(parseTopicCandidateFile);

  const queryResults: RetrieveEvalQueryResult[] = [];

  for (const fixture of fixtures) {
    const start = Date.now();
    const response = buildRetrieveResponse(fixture.query, vaultRoot, allCandidates);
    const durationMs = Date.now() - start;

    const topResult = response.results[0];
    const topResultPath = topResult !== undefined ? topResult.path : null;
    const topScore = topResult !== undefined ? topResult.score : 0;

    // Normalize top result path to vault-relative form.
    const normalizedTopPath =
      topResultPath !== null ? normalizePath(topResultPath, vaultRoot) : null;

    // Check if any expected path matches the top result.
    const hit =
      normalizedTopPath !== null &&
      fixture.expected_topic_paths.some((expected) => {
        const normalizedExpected = expected.startsWith("/")
          ? normalizePath(expected, vaultRoot)
          : expected;
        return (
          normalizedTopPath === normalizedExpected ||
          basename(normalizedTopPath) === basename(normalizedExpected)
        );
      });

    queryResults.push({
      query: fixture.query,
      top_result_path: topResultPath,
      confidence: response.confidence,
      hit,
      coverage_gap: response.coverage_gap,
      top_score: topScore,
      duration_ms: durationMs,
    });
  }

  // Aggregate metrics.
  const total = queryResults.length;
  const hitCount = queryResults.filter((r) => r.hit).length;
  const highCount = queryResults.filter((r) => r.confidence === "high").length;
  const mediumCount = queryResults.filter((r) => r.confidence === "medium").length;
  const lowCount = queryResults.filter((r) => r.confidence === "low").length;
  const gapCount = queryResults.filter((r) => r.coverage_gap).length;
  const medianDuration = median(queryResults.map((r) => r.duration_ms));

  const metrics: RetrieveEvalMetrics = {
    total_queries: total,
    hit_count: hitCount,
    hit_rate: total > 0 ? hitCount / total : 0,
    high_confidence_count: highCount,
    medium_confidence_count: mediumCount,
    low_confidence_count: lowCount,
    coverage_gap_count: gapCount,
    median_duration_ms: medianDuration,
  };

  return {
    schema_version: RETRIEVE_EVAL_SCHEMA_VERSION,
    vault_root: vaultRoot,
    run_at: runAt,
    query_results: queryResults,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Eval thresholds — Task 14
// ---------------------------------------------------------------------------

/**
 * Minimum acceptable hit rate for the eval harness.
 * A value of 0.8 requires at least 80% of queries to return the expected
 * topic map as the top result.
 */
export const EVAL_THRESHOLDS = {
  min_hit_rate: 0.8,
} as const;

/**
 * Check whether the eval metrics satisfy all defined thresholds.
 *
 * @param metrics - Aggregate metrics from a RetrieveEvalReport.
 * @returns An object with `pass` (boolean) and `reasons` (array of failure strings).
 */
export function checkEvalThresholds(
  metrics: RetrieveEvalMetrics,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (metrics.hit_rate < EVAL_THRESHOLDS.min_hit_rate) {
    reasons.push(
      `hit_rate ${metrics.hit_rate.toFixed(2)} below threshold ${EVAL_THRESHOLDS.min_hit_rate}`,
    );
  }

  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleRetrieve(
  args: string[],
  getCwd: () => string = () => process.cwd(),
  fixturesPath: string = DEFAULT_EVAL_FIXTURES_PATH,
): DispatchOutcome {
  const evalFlag = args.includes("--eval");
  const positional = args.filter((a) => !a.startsWith("--"));

  if (evalFlag) {
    const resolution = resolveVaultRoot(positional, getCwd);
    if (!resolution.ok) return resolution.outcome;

    const { vaultRoot } = resolution;
    const fixtures = loadEvalFixtures(fixturesPath);
    const report = runRetrieveEval(vaultRoot, fixtures);
    const { pass } = checkEvalThresholds(report.metrics);

    return {
      exitCode: pass ? ExitCode.SUCCESS : ExitCode.VALIDATION,
      result: success("retrieve", report as unknown as Record<string, unknown>),
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

  const query = remainder.join(" ");

  // Load and parse topic candidates.
  const rawFiles = loadTopicCandidateFiles(vaultRoot);
  const allCandidates = rawFiles.map(parseTopicCandidateFile);

  // Assemble the final response (always succeeds; coverage gaps use coverage_gap flag).
  const response = buildRetrieveResponse(query, vaultRoot, allCandidates);

  return {
    exitCode: ExitCode.SUCCESS,
    result: success("retrieve", response as unknown as Record<string, unknown>),
  };
}
