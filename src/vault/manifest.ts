import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import type { ErrorObject, ValidateFunction } from "ajv";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli.js";
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

export type SourceKind = "local" | "google_drive" | "granola";
export type SourceStatus = "committed" | "skipped";
export type InspectOutcome = "new" | "already_processed" | "changed_conflict";

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
    sources: [...manifest.sources].sort((left, right) =>
      left.source_key.localeCompare(right.source_key),
    ),
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
  }
  if (record.status === "skipped") {
    if (record.skip_reason === undefined || record.skip_reason.trim() === "") {
      throw new ManifestValidationError("Skipped records require skip_reason");
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
  let wroteManagedFiles = false;

  for (const [relativePath, expectedContent] of Object.entries(MANAGED_INIT_FILES)) {
    const fullPath = join(root, relativePath);
    if (fs.existsSync(fullPath)) {
      const existing = fs.readFileSync(fullPath, "utf8");
      if (existing !== expectedContent) {
        throw new ManagedFileConflictError(relativePath);
      }
      continue;
    }
    fs.mkdirSync(dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, expectedContent, "utf8");
    wroteManagedFiles = true;
  }

  ensureInitDirectories(root);

  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  let manifest: Manifest;
  if (!fs.existsSync(manifestPath)) {
    manifest = createEmptyManifest();
    saveManifest(root, manifest);
    wroteManagedFiles = true;
  } else {
    manifest = loadManifest(root);
  }

  ensureGitignore(root);
  initRepository(root);
  const commitResult = commitInitializationBaseline(root);

  return {
    vault_root: root,
    idempotent: !wroteManagedFiles && !commitResult.committed,
    committed: commitResult.committed,
    ...(commitResult.commit !== undefined ? { commit: commitResult.commit } : {}),
    revision: manifestRevision(manifest),
  };
}

export function handleInit(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("init", "USAGE_MISSING_ARGS", "Usage: init <vault-root>"),
      diagnostic: "Missing required argument for init.",
    };
  }

  try {
    const data = initializeVault(vaultRoot);
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

  if (kind !== "local" && kind !== "google_drive" && kind !== "granola") {
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
