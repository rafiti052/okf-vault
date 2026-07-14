import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import {
  MANAGED_INIT_FILES,
  MANIFEST_RELATIVE_PATH,
  MANIFEST_SCHEMA_VERSION,
  NOTE_CONTRACT_VERSION,
} from "./constants.js";
import {
  commitInitializationBaseline,
  ensureGitignore,
  ensureInitDirectories,
  initRepository,
} from "./git.js";

export type SourceKind = "local" | "google_drive" | "granola" | "youtube";
export type SourceStatus = "committed" | "skipped";
export type InspectOutcome = "new" | "already_processed" | "changed_conflict";
export type SourceSpanProfile = "article" | "video" | "panel" | "deck";
export type SourceSpanSchemaVersion = "okf-source-spans/1.0.0";

export interface SourceSpanRef {
  id: string;
  path: string;
  sha256: string;
  profile: SourceSpanProfile;
  sequence: number;
  anchor_ids: string[];
  prev_id?: string;
  next_id?: string;
}

export interface SourceSpanIndex {
  schema_version: SourceSpanSchemaVersion;
  profile: SourceSpanProfile;
  default_expansion: {
    previous: 1;
    next: 1;
  };
  spans: SourceSpanRef[];
}

export interface SourceRecord {
  source_key: string;
  kind: SourceKind;
  origin: string;
  content_sha256: string;
  contract_version: string;
  note_path?: string;
  status: SourceStatus;
  commit?: string;
  skip_reason?: string;
  source_span_index?: SourceSpanIndex;
  processed_at: string;
}

export interface Manifest {
  schema_version: typeof MANIFEST_SCHEMA_VERSION;
  note_contract_version: string;
  sources: SourceRecord[];
}

export class ManagedFileConflictError extends Error {
  constructor(public readonly relativePath: string) {
    super(`Managed file conflict at ${relativePath}`);
    this.name = "ManagedFileConflictError";
  }
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../schemas/manifest.schema.json",
);

let manifestValidator: ValidateFunction | undefined;

function getManifestValidator(): ValidateFunction {
  if (manifestValidator === undefined) {
    const Ajv2020 = Ajv2020Import as unknown as new (options?: object) => {
      compile: (schema: object) => ValidateFunction;
    };
    const addFormats = addFormatsImport as unknown as (ajv: InstanceType<typeof Ajv2020>) => void;
    const ajv = new Ajv2020({ allErrors: true, strict: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8")) as object;
    manifestValidator = ajv.compile(schema);
  }
  return manifestValidator;
}

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function extractYoutubeVideoId(origin: string): string {
  let input = origin.trim();
  if (input.startsWith("youtube:")) {
    input = input.slice("youtube:".length);
  }

  if (YOUTUBE_VIDEO_ID_PATTERN.test(input)) {
    return input;
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid YouTube origin: ${origin}`);
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0] ?? "";
    if (YOUTUBE_VIDEO_ID_PATTERN.test(id)) {
      return id;
    }
  }

  if (host === "youtube.com" || host === "m.youtube.com") {
    const fromQuery = url.searchParams.get("v");
    if (fromQuery !== null && YOUTUBE_VIDEO_ID_PATTERN.test(fromQuery)) {
      return fromQuery;
    }

    const pathMatch = url.pathname.match(/^\/(embed|v|shorts)\/([A-Za-z0-9_-]{11})/);
    if (pathMatch !== null && YOUTUBE_VIDEO_ID_PATTERN.test(pathMatch[2]!)) {
      return pathMatch[2]!;
    }
  }

  throw new Error(`Invalid YouTube origin: ${origin}`);
}

export function deriveSourceKey(kind: SourceKind, origin: string): string {
  switch (kind) {
    case "local": {
      const normalized = resolve(origin).split("\\").join("/");
      return `local:${normalized}`;
    }
    case "google_drive": {
      const id = origin.startsWith("drive:") ? origin.slice("drive:".length) : origin;
      return `drive:${id}`;
    }
    case "granola": {
      const id = origin.startsWith("granola:") ? origin.slice("granola:".length) : origin;
      return `granola:${id}`;
    }
    case "youtube": {
      const videoId = extractYoutubeVideoId(origin);
      return `youtube:${videoId}`;
    }
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported source kind: ${String(exhaustive)}`);
    }
  }
}

export function createEmptyManifest(): Manifest {
  return {
    schema_version: MANIFEST_SCHEMA_VERSION,
    note_contract_version: NOTE_CONTRACT_VERSION,
    sources: [],
  };
}

export function canonicalizeManifest(manifest: Manifest): Manifest {
  return {
    schema_version: manifest.schema_version,
    note_contract_version: manifest.note_contract_version,
    sources: manifest.sources
      .map((record) => canonicalizeSourceRecord(record))
      .sort((left, right) => left.source_key.localeCompare(right.source_key)),
  };
}

function canonicalizeSourceRecord(record: SourceRecord): SourceRecord {
  if (record.source_span_index === undefined) {
    return { ...record };
  }

  return {
    ...record,
    source_span_index: {
      schema_version: record.source_span_index.schema_version,
      profile: record.source_span_index.profile,
      default_expansion: {
        previous: record.source_span_index.default_expansion.previous,
        next: record.source_span_index.default_expansion.next,
      },
      spans: record.source_span_index.spans
        .map((span) => ({
          id: span.id,
          path: span.path,
          sha256: span.sha256,
          profile: span.profile,
          sequence: span.sequence,
          anchor_ids: [...span.anchor_ids].sort((left, right) => left.localeCompare(right)),
          ...(span.prev_id === undefined ? {} : { prev_id: span.prev_id }),
          ...(span.next_id === undefined ? {} : { next_id: span.next_id }),
        }))
        .sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id)),
    },
  };
}

export function serializeManifest(manifest: Manifest): string {
  const canonical = canonicalizeManifest(manifest);
  return `${JSON.stringify(canonical, null, 2)}\n`;
}

export function manifestRevision(manifest: Manifest): string {
  return createHash("sha256").update(serializeManifest(manifest)).digest("hex");
}

export class ManifestRevisionMismatchError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`Manifest revision mismatch: expected ${expected}, found ${actual}`);
    this.name = "ManifestRevisionMismatchError";
  }
}

export function assertManifestRevision(manifest: Manifest, expectedRevision: string): void {
  const actual = manifestRevision(manifest);
  if (actual !== expectedRevision) {
    throw new ManifestRevisionMismatchError(expectedRevision, actual);
  }
}

export function upsertCommittedSource(manifest: Manifest, record: SourceRecord): Manifest {
  validateSourceRecord(record);
  const withoutExisting = manifest.sources.filter(
    (entry) => entry.source_key !== record.source_key,
  );
  return canonicalizeManifest({
    ...manifest,
    sources: [...withoutExisting, record],
  });
}

export function upsertSkippedSource(manifest: Manifest, record: SourceRecord): Manifest {
  if (record.status !== "skipped") {
    throw new ManifestValidationError("upsertSkippedSource requires status 'skipped'");
  }
  return upsertCommittedSource(manifest, record);
}

export function validateManifestSchema(manifest: Manifest): void {
  if (manifest.schema_version !== MANIFEST_SCHEMA_VERSION) {
    throw new ManifestValidationError(
      `Unsupported manifest schema_version '${manifest.schema_version}'`,
    );
  }
  if (manifest.note_contract_version !== NOTE_CONTRACT_VERSION) {
    throw new ManifestValidationError(
      `Unsupported note_contract_version '${manifest.note_contract_version}'`,
    );
  }
  const validate = getManifestValidator();
  if (!validate(manifest)) {
    const detail =
      validate.errors?.map((error: ErrorObject) => error.message).join("; ") ?? "invalid";
    throw new ManifestValidationError(`Manifest schema validation failed: ${detail}`);
  }
}

export function validateSourceRecord(record: SourceRecord): void {
  if (record.status !== "committed" && record.status !== "skipped") {
    throw new ManifestValidationError(`Unsupported source status '${String(record.status)}'`);
  }
  if (record.contract_version !== NOTE_CONTRACT_VERSION) {
    throw new ManifestValidationError(
      `Unsupported source contract_version '${record.contract_version}'`,
    );
  }
  if (record.status === "committed") {
    if (record.note_path === undefined || record.note_path.trim() === "") {
      throw new ManifestValidationError("Committed records require note_path");
    }
    if (record.commit === undefined || record.commit.length < 7) {
      throw new ManifestValidationError("Committed records require commit");
    }
    if (
      record.source_span_index?.spans.some(
        (span) => span.profile !== record.source_span_index?.profile,
      ) === true
    ) {
      throw new ManifestValidationError(
        "Source span profiles must match source_span_index.profile",
      );
    }
  }
  if (record.status === "skipped") {
    if (record.skip_reason === undefined || record.skip_reason.trim() === "") {
      throw new ManifestValidationError("Skipped records require skip_reason");
    }
    if (record.source_span_index !== undefined) {
      throw new ManifestValidationError("Skipped records cannot include source_span_index");
    }
  }
  validateManifestSchema({
    schema_version: MANIFEST_SCHEMA_VERSION,
    note_contract_version: NOTE_CONTRACT_VERSION,
    sources: [record],
  });
}

export function loadManifest(vaultRoot: string): Manifest {
  const manifestPath = join(resolve(vaultRoot), MANIFEST_RELATIVE_PATH);
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
  validateManifestSchema(raw);
  for (const record of raw.sources) {
    validateSourceRecord(record);
  }
  return canonicalizeManifest(raw);
}

export function saveManifest(vaultRoot: string, manifest: Manifest): void {
  validateManifestSchema(manifest);
  for (const record of manifest.sources) {
    validateSourceRecord(record);
  }

  const manifestPath = join(resolve(vaultRoot), MANIFEST_RELATIVE_PATH);
  fs.mkdirSync(dirname(manifestPath), { recursive: true });
  const content = serializeManifest(canonicalizeManifest(manifest));
  const tmpPath = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, manifestPath);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

export function inspectSource(
  manifest: Manifest,
  sourceKey: string,
  contentSha256: string,
): InspectOutcome {
  const existing = manifest.sources.find((record) => record.source_key === sourceKey);
  if (existing === undefined) {
    return "new";
  }
  if (existing.content_sha256 === contentSha256) {
    return "already_processed";
  }
  return "changed_conflict";
}

export function utcNow(): string {
  return new Date().toISOString();
}

export interface InitializeVaultResult {
  vault_root: string;
  idempotent: boolean;
  committed: boolean;
  commit?: string;
  revision: string;
}

export function initializeVault(vaultRoot: string): InitializeVaultResult {
  const root = resolve(vaultRoot);
  let updated = false;
  const updatedPaths = new Set<string>();
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  const existingManifest = fs.existsSync(manifestPath);

  for (const [relativePath, expectedContent] of Object.entries(MANAGED_INIT_FILES)) {
    const fullPath = join(root, relativePath);
    if (fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, "utf8");
      if (!existingManifest && existing !== expectedContent) {
        throw new ManagedFileConflictError(relativePath);
      }
      continue;
    }
    fs.mkdirSync(dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, expectedContent, "utf8");
    updated = true;
    updatedPaths.add(relativePath);
  }

  const directoryResult = ensureInitDirectories(root);
  updated = directoryResult.updated || updated;
  for (const relativePath of directoryResult.filesCreated) {
    updatedPaths.add(relativePath);
  }

  let manifest: Manifest;
  if (!fs.existsSync(manifestPath)) {
    manifest = createEmptyManifest();
    saveManifest(root, manifest);
    updated = true;
    updatedPaths.add(MANIFEST_RELATIVE_PATH);
  } else {
    manifest = loadManifest(root);
  }

  if (ensureGitignore(root)) {
    updated = true;
    updatedPaths.add(".gitignore");
  }
  updated = initRepository(root) || updated;
  const commitResult = commitInitializationBaseline(root, [...updatedPaths]);

  return {
    vault_root: root,
    idempotent: !updated && !commitResult.committed,
    committed: commitResult.committed,
    ...(commitResult.commit !== undefined ? { commit: commitResult.commit } : {}),
    revision: manifestRevision(manifest),
  };
}

const CANONICAL_SKILL_RELATIVE = join(".agents", "skills", "okf-vault");
const CURATOR_RULE_RELATIVE = join(".cursor", "rules", "okv.mdc");
const CURATOR_RULE_TEMPLATE_RELATIVE = join(CANONICAL_SKILL_RELATIVE, "templates", "okv.mdc");

interface RuntimeAdapterInstallResult {
  linked: string[];
  skipped: string[];
  removed: string[];
}

export function resolveInstallRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (true) {
    const candidate = join(dir, CANONICAL_SKILL_RELATIVE);
    if (fs.existsSync(candidate)) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error("Could not resolve okf-vault install root");
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function installRuntimeAdapters(
  projectRoot: string,
  installRoot: string,
): RuntimeAdapterInstallResult {
  const scriptPath = join(installRoot, "scripts", "link-runtime-adapters.mjs");
  const canonicalSkillRoot = join(installRoot, CANONICAL_SKILL_RELATIVE);
  const result = spawnSync(
    process.execPath,
    [
      scriptPath,
      "--json",
      "--project-root",
      projectRoot,
      "--canonical-skill-root",
      canonicalSkillRoot,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "unknown error";
    throw new Error(`Failed to install runtime adapters: ${detail}`);
  }
  const parsed = JSON.parse(result.stdout) as {
    data?: { linked?: unknown; skipped?: unknown; removed?: unknown };
  };
  const data = parsed.data ?? {};
  return {
    linked: isStringArray(data.linked) ? data.linked : [],
    skipped: isStringArray(data.skipped) ? data.skipped : [],
    removed: isStringArray(data.removed) ? data.removed : [],
  };
}

export function installCuratorRule(projectRoot: string, installRoot: string): boolean {
  const rulePath = join(projectRoot, CURATOR_RULE_RELATIVE);
  const templatePath = join(installRoot, CURATOR_RULE_TEMPLATE_RELATIVE);
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing curator rule template at ${templatePath}`);
  }
  if (fs.existsSync(rulePath)) {
    const existing = fs.readFileSync(rulePath, "utf8");
    const expected = fs.readFileSync(templatePath, "utf8");
    if (existing === expected) {
      return false;
    }
  }
  fs.mkdirSync(dirname(rulePath), { recursive: true });
  fs.copyFileSync(templatePath, rulePath);
  return true;
}

export function handleInit(args: string[]): DispatchOutcome {
  const explicitVaultRoot = args[0];
  if (args.length > 1) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "init",
        "USAGE_UNEXPECTED_ARGS",
        "Usage: init [vault-root]. Init does not support additional flags.",
      ),
      diagnostic: "Unexpected arguments for init.",
    };
  }
  if (explicitVaultRoot?.startsWith("-") === true) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "init",
        "USAGE_INVALID_VAULT_ROOT",
        "Vault root must be a path, not an option flag. Use './' before paths that begin with '-'.",
      ),
      diagnostic: "Invalid vault root argument for init.",
    };
  }
  const repoRootBootstrap = explicitVaultRoot === undefined;
  const projectRoot = resolve(process.cwd());
  const vaultRoot = repoRootBootstrap ? join(projectRoot, "knowledge") : explicitVaultRoot;

  try {
    const data = initializeVault(vaultRoot);
    if (repoRootBootstrap) {
      const installRoot = resolveInstallRoot();
      const adapters = installRuntimeAdapters(projectRoot, installRoot);
      const curatorRuleInstalled = installCuratorRule(projectRoot, installRoot);
      const legacyRemoved = adapters.removed;
      const alignmentUpdated =
        curatorRuleInstalled || adapters.linked.length > 0 || legacyRemoved.length > 0;
      return {
        exitCode: ExitCode.SUCCESS,
        result: success("init", {
          ...data,
          idempotent: data.idempotent && !alignmentUpdated,
          vault_root: resolve(vaultRoot),
          project_root: projectRoot,
          adapters_installed: true,
          adapter_links_created: adapters.linked.length,
          adapter_links_skipped: adapters.skipped.length,
          curator_rule_installed: curatorRuleInstalled,
          curator_rule_path: join(projectRoot, CURATOR_RULE_RELATIVE),
          legacy_paths_removed: legacyRemoved.length,
          legacy_removed: legacyRemoved,
          linked: adapters.linked,
          skipped: adapters.skipped,
          removed: adapters.removed,
        }),
      };
    }

    return {
      exitCode: ExitCode.SUCCESS,
      result: success("init", { ...data }),
    };
  } catch (error) {
    if (error instanceof ManagedFileConflictError) {
      return {
        exitCode: ExitCode.CONFLICT,
        result: failure("init", "MANAGED_FILE_CONFLICT", error.message, {
          path: error.relativePath,
        }),
        diagnostic: error.message,
      };
    }
    const message = error instanceof Error ? error.message : "Initialization failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("init", "INIT_FAILED", message),
      diagnostic: message,
    };
  }
}

export function validateManifestDiskConsistency(
  vaultRoot: string,
): { code: string; message: string; path?: string }[] {
  const root = resolve(vaultRoot);
  const manifest = loadManifest(vaultRoot);
  const issues: { code: string; message: string; path?: string }[] = [];
  const manifestPaths = new Set<string>();

  for (const record of manifest.sources) {
    if (record.status !== "committed" || record.note_path === undefined) {
      continue;
    }
    manifestPaths.add(record.note_path);
    const absolutePath = join(root, record.note_path);
    if (!fs.existsSync(absolutePath)) {
      issues.push({
        code: "MANIFEST_DRIFT",
        message: `Manifest record references missing note path '${record.note_path}'.`,
        path: record.note_path,
      });
    }
  }

  const notesDir = join(root, "notes");
  if (fs.existsSync(notesDir)) {
    for (const entry of fs.readdirSync(notesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
        continue;
      }
      const relativePath = `notes/${entry.name}`;
      if (!manifestPaths.has(relativePath)) {
        issues.push({
          code: "MANIFEST_DRIFT",
          message: `On-disk note '${relativePath}' has no committed manifest record.`,
          path: relativePath,
        });
      }
    }
  }

  return issues;
}

export function handleInspect(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  const kind = args[1];
  const origin = args[2];
  const contentSha256 = args[3];

  if (
    vaultRoot === undefined ||
    kind === undefined ||
    origin === undefined ||
    contentSha256 === undefined
  ) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "inspect",
        "USAGE_MISSING_ARGS",
        "Usage: inspect <vault-root> <kind> <origin> <content-sha256>",
      ),
      diagnostic: "Missing required arguments for inspect.",
    };
  }

  if (kind !== "local" && kind !== "google_drive" && kind !== "granola" && kind !== "youtube") {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("inspect", "USAGE_INVALID_KIND", `Unsupported source kind: ${kind}`),
      diagnostic: `Unsupported source kind: ${kind}`,
    };
  }

  try {
    const manifest = loadManifest(vaultRoot);
    const sourceKey = deriveSourceKey(kind, origin);
    const outcome = inspectSource(manifest, sourceKey, contentSha256);
    const record = manifest.sources.find((entry) => entry.source_key === sourceKey);
    return {
      exitCode: outcome === "changed_conflict" ? ExitCode.CONFLICT : ExitCode.SUCCESS,
      result: success("inspect", {
        source_key: sourceKey,
        outcome,
        revision: manifestRevision(manifest),
        ...(record !== undefined ? { record } : {}),
      }),
      ...(outcome === "changed_conflict"
        ? { diagnostic: "Source content hash changed for an existing manifest record." }
        : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Inspection failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("inspect", "INSPECT_FAILED", message),
      diagnostic: message,
    };
  }
}
