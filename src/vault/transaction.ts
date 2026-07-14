import * as fs from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli/cli.js";
import {
  JOURNAL_RELATIVE_PATH,
  LOCK_RELATIVE_PATH,
  LOG_PATH,
  MANIFEST_RELATIVE_PATH,
  NOTE_CONTRACT_VERSION,
  SOURCE_SPANS_DIR,
  TMP_DIR,
} from "./constants.js";
import {
  amendCommitNoEdit,
  createCommit,
  getHeadCommit,
  getManagedPathStatus,
  isGitRepository,
  readManagedFileFromHead,
  runGit,
  stageManagedPaths,
  unstageManagedPaths,
} from "./git.js";
import {
  assertManifestRevision,
  inspectSource,
  loadManifest,
  ManifestRevisionMismatchError,
  manifestRevision,
  removeSourceRecord,
  serializeManifest,
  sourceSpanPathsForRecord,
  upsertCommittedSource,
  utcNow,
  type Manifest,
  type SourceRecord,
  type SourceSpanIndex,
} from "./manifest.js";
import { renderSourceSpanMarkdown } from "./source-spans.js";
import {
  detectStagedSourceProfile,
  generateSourceSpanDocuments,
  loadSourceEnvelope,
  sourceSpanContentSha256,
  validateStagedNotes,
  type SourceEnvelope,
  type ValidateStagedResult,
} from "./validation.js";

export const TRANSACTION_JOURNAL_VERSION = "okf-vault-transaction-journal/1.0.0" as const;
export const PLACEHOLDER_COMMIT = "0000000";

export class VaultLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultLockError";
  }
}

export class TransactionPreflightError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TransactionPreflightError";
  }
}

export class TransactionFailureError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TransactionFailureError";
  }
}

export interface ManagedSnapshot {
  manifest: string;
  log: string;
  notes: Record<string, string>;
  /** Absent only in journals written before source-span transaction support. */
  source_spans?: Record<string, string>;
}

export interface VaultLockPayload {
  run_id: string;
  pid: number;
  acquired_at: string;
  expected_revision: string;
  phase: "locked" | "installing" | "committing";
}

export interface TransactionJournal {
  schema_version: typeof TRANSACTION_JOURNAL_VERSION;
  run_id: string;
  source_key: string;
  phase: "install" | "commit";
  failed_at: string;
  error_code: string;
  error_message: string;
  snapshot: ManagedSnapshot;
  installed_paths: string[];
}

export interface TransactionHooks {
  renameSync?: typeof fs.renameSync;
  createCommit?: (vaultRoot: string, message: string) => string;
  amendCommit?: (vaultRoot: string) => string;
  afterValidation?: (vaultRoot: string) => void;
}

export interface CommitStagedInput {
  vaultRoot: string;
  runId: string;
  envelopePath: string;
  expectedRevision: string;
  /** Required to replace a committed record whose source bytes changed. */
  supersede?: boolean;
  hooks?: TransactionHooks;
}

export interface CommitStagedResult {
  run_id: string;
  source_key: string;
  note_path: string;
  commit: string;
  revision: string;
  staged_paths: string[];
  source_profile: SourceSpanIndex["profile"];
  source_span_count: number;
  source_span_paths: string[];
}

export interface PurgeCommittedSourceInput {
  vaultRoot: string;
  runId: string;
  sourceKey: string;
  expectedRevision: string;
  hooks?: Pick<TransactionHooks, "renameSync" | "createCommit">;
}

export interface PurgeCommittedSourceResult {
  run_id: string;
  source_key: string;
  removed_paths: string[];
  commit: string;
  revision: string;
}

function lockPath(vaultRoot: string): string {
  return join(resolve(vaultRoot), LOCK_RELATIVE_PATH);
}

function journalPath(vaultRoot: string): string {
  return join(resolve(vaultRoot), JOURNAL_RELATIVE_PATH);
}

function stagingPath(vaultRoot: string, runId: string): string {
  return join(resolve(vaultRoot), TMP_DIR, runId);
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(fs.readFileSync(path, "utf8")) as T;
}

function writeJsonAtomic(path: string, value: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    fs.renameSync(tmpPath, path);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function writeFileAtomic(path: string, content: string, renameSync: typeof fs.renameSync): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
}

function removeIfExists(path: string): void {
  if (fs.existsSync(path)) {
    fs.rmSync(path, { force: true });
  }
}

function removeTreeIfExists(path: string): void {
  try {
    if (fs.existsSync(path)) {
      fs.rmSync(path, { recursive: true, force: true });
    }
  } catch {
    // Cleanup is best-effort after the durable commit has succeeded.
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readVaultLock(vaultRoot: string): VaultLockPayload | undefined {
  const path = lockPath(vaultRoot);
  if (!fs.existsSync(path)) {
    return undefined;
  }
  return readJsonFile<VaultLockPayload>(path);
}

export function readTransactionJournal(vaultRoot: string): TransactionJournal | undefined {
  const path = journalPath(vaultRoot);
  if (!fs.existsSync(path)) {
    return undefined;
  }
  return readJsonFile<TransactionJournal>(path);
}

export function isLockStale(lock: VaultLockPayload): boolean {
  return !isProcessAlive(lock.pid);
}

export function acquireVaultLock(
  vaultRoot: string,
  runId: string,
  expectedRevision: string,
): VaultLockPayload {
  const existingLock = readVaultLock(vaultRoot);
  if (existingLock !== undefined && !isLockStale(existingLock)) {
    throw new VaultLockError(`Vault lock held by run '${existingLock.run_id}'`);
  }
  if (existingLock !== undefined && isLockStale(existingLock)) {
    removeIfExists(lockPath(vaultRoot));
  }

  const journal = readTransactionJournal(vaultRoot);
  if (journal !== undefined && journal.run_id !== runId) {
    throw new TransactionPreflightError(
      `Unresolved transaction journal for run '${journal.run_id}'`,
      "UNRESOLVED_JOURNAL",
      { run_id: journal.run_id },
    );
  }

  const payload: VaultLockPayload = {
    run_id: runId,
    pid: process.pid,
    acquired_at: utcNow(),
    expected_revision: expectedRevision,
    phase: "locked",
  };
  writeJsonAtomic(lockPath(vaultRoot), payload);
  return payload;
}

export function releaseVaultLock(vaultRoot: string, runId?: string): void {
  const existing = readVaultLock(vaultRoot);
  if (existing === undefined) {
    return;
  }
  if (runId !== undefined && existing.run_id !== runId) {
    return;
  }
  removeIfExists(lockPath(vaultRoot));
}

export function updateVaultLockPhase(vaultRoot: string, phase: VaultLockPayload["phase"]): void {
  const existing = readVaultLock(vaultRoot);
  if (existing === undefined) {
    return;
  }
  writeJsonAtomic(lockPath(vaultRoot), { ...existing, phase });
}

export function captureManagedSnapshot(
  vaultRoot: string,
  notePath: string,
  additionalNotePaths: readonly string[] = [],
): ManagedSnapshot {
  const root = resolve(vaultRoot);
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  const logFilePath = join(root, LOG_PATH);
  const notes: Record<string, string> = {};

  for (const managedNotePath of new Set([notePath, ...additionalNotePaths])) {
    const noteFullPath = join(root, managedNotePath);
    if (fs.existsSync(noteFullPath)) {
      notes[managedNotePath] = fs.readFileSync(noteFullPath, "utf8");
    }
  }

  const sourceSpans: Record<string, string> = {};
  const sourceSpansRoot = join(root, SOURCE_SPANS_DIR);
  const captureSourceSpanDirectory = (fullDirectory: string, relativeDirectory: string): void => {
    const entries = fs
      .readdirSync(fullDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const fullPath = join(fullDirectory, entry.name);
      const relativePath = join(relativeDirectory, entry.name).split("\\").join("/");
      if (entry.isDirectory()) {
        captureSourceSpanDirectory(fullPath, relativePath);
      } else if (entry.isFile()) {
        sourceSpans[relativePath] = fs.readFileSync(fullPath, "utf8");
      }
    }
  };
  if (fs.existsSync(sourceSpansRoot)) {
    captureSourceSpanDirectory(sourceSpansRoot, SOURCE_SPANS_DIR);
  }

  return {
    manifest: fs.readFileSync(manifestPath, "utf8"),
    log: fs.readFileSync(logFilePath, "utf8"),
    notes,
    source_spans: sourceSpans,
  };
}

function resolveSnapshotSourceSpanPath(root: string, relativePath: string): string {
  const sourceSpansRoot = resolve(root, SOURCE_SPANS_DIR);
  const fullPath = resolve(root, relativePath);
  const relativeToSourceSpans = relative(sourceSpansRoot, fullPath);
  if (
    relativeToSourceSpans.length === 0 ||
    relativeToSourceSpans === ".." ||
    relativeToSourceSpans.startsWith(`..${sep}`) ||
    isAbsolute(relativeToSourceSpans)
  ) {
    throw new TransactionFailureError(
      `Source-span snapshot path is outside '${SOURCE_SPANS_DIR}': ${relativePath}`,
      "SOURCE_SPAN_SNAPSHOT_PATH_INVALID",
      { path: relativePath },
    );
  }
  return fullPath;
}

export function restoreManagedSnapshot(vaultRoot: string, snapshot: ManagedSnapshot): void {
  const root = resolve(vaultRoot);
  writeFileAtomic(join(root, MANIFEST_RELATIVE_PATH), snapshot.manifest, fs.renameSync);
  writeFileAtomic(join(root, LOG_PATH), snapshot.log, fs.renameSync);

  for (const [relativePath, content] of Object.entries(snapshot.notes)) {
    writeFileAtomic(join(root, relativePath), content, fs.renameSync);
  }

  if (snapshot.source_spans !== undefined) {
    const sourceSpanEntries = Object.entries(snapshot.source_spans)
      .map(
        ([relativePath, content]) =>
          [relativePath, resolveSnapshotSourceSpanPath(root, relativePath), content] as const,
      )
      .sort(([left], [right]) => left.localeCompare(right));
    const sourceSpansRoot = join(root, SOURCE_SPANS_DIR);
    fs.rmSync(sourceSpansRoot, { recursive: true, force: true });
    fs.mkdirSync(sourceSpansRoot, { recursive: true });
    for (const [, fullPath, content] of sourceSpanEntries) {
      writeFileAtomic(fullPath, content, fs.renameSync);
    }
  }
}

export function writeFailureJournal(vaultRoot: string, journal: TransactionJournal): void {
  writeJsonAtomic(journalPath(vaultRoot), journal);
}

export function clearFailureJournal(vaultRoot: string): void {
  removeIfExists(journalPath(vaultRoot));
}

function removeInstalledNotesAbsentFromSnapshot(
  vaultRoot: string,
  installedPaths: readonly string[],
  snapshot: ManagedSnapshot,
): void {
  for (const relativePath of installedPaths) {
    if (relativePath.startsWith("notes/") && !(relativePath in snapshot.notes)) {
      removeIfExists(join(resolve(vaultRoot), relativePath));
    }
  }
}

function assertVaultReady(vaultRoot: string): void {
  const root = resolve(vaultRoot);
  if (!fs.existsSync(join(root, MANIFEST_RELATIVE_PATH))) {
    throw new TransactionPreflightError("Vault is not initialized", "VAULT_NOT_INITIALIZED");
  }
  if (!isGitRepository(root)) {
    throw new TransactionPreflightError("Vault is not a Git repository", "VAULT_NOT_GIT");
  }
}

function assertNoUnresolvedTransactionState(vaultRoot: string, runId: string): void {
  const lock = readVaultLock(vaultRoot);
  if (lock !== undefined && !isLockStale(lock) && lock.run_id !== runId) {
    throw new TransactionPreflightError(`Vault lock held by run '${lock.run_id}'`, "VAULT_LOCKED", {
      run_id: lock.run_id,
    });
  }

  const journal = readTransactionJournal(vaultRoot);
  if (journal !== undefined && journal.run_id !== runId) {
    throw new TransactionPreflightError(
      `Unresolved transaction journal for run '${journal.run_id}'`,
      "UNRESOLVED_JOURNAL",
      { run_id: journal.run_id },
    );
  }
}

function assertCleanManagedPaths(
  vaultRoot: string,
  allowedDirtyPaths: readonly string[] = [],
): void {
  const status = getManagedPathStatus(vaultRoot);
  if (status.clean) {
    return;
  }

  const allowed = new Set(allowedDirtyPaths);
  const unexpected = status.dirtyPaths.filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new TransactionPreflightError(
      `Managed path conflict at ${unexpected[0]}`,
      "MANAGED_PATH_CONFLICT",
      { path: unexpected[0], dirty_paths: unexpected },
    );
  }
}

function buildLogEntry(sourceKey: string, notePath: string, processedAt: string): string {
  return `\n## ${processedAt} — ${sourceKey}\n\n- note: ${notePath}\n`;
}

function buildPurgeLogEntry(sourceKey: string, notePath: string, processedAt: string): string {
  return `\n## ${processedAt} — ${sourceKey}\n\n- purged: ${notePath}\n`;
}

function validatePreparedStaging(
  vaultRoot: string,
  stagingDir: string,
  envelope: SourceEnvelope,
): ValidateStagedResult {
  let validation = validateStagedNotes(vaultRoot, stagingDir, envelope);
  if (validation.report.status !== "pass") {
    throw new TransactionPreflightError(validation.report.summary, "STAGED_VALIDATION_FAILED", {
      issues: validation.report.issues,
    });
  }
  if (validation.staged_paths.length !== 1) {
    throw new TransactionPreflightError(
      "Exactly one staged note is required per transaction",
      "STAGED_NOTE_COUNT_INVALID",
      { staged_paths: validation.staged_paths },
    );
  }

  if (validation.source_span_count === 0) {
    const sourceProfile = detectStagedSourceProfile(stagingDir);
    if (sourceProfile === undefined) {
      throw new TransactionPreflightError(
        "Exactly one supported source-note profile is required to generate source spans",
        "STAGED_SOURCE_PROFILE_INVALID",
      );
    }
    const documents = generateSourceSpanDocuments(sourceProfile, envelope);
    for (const document of documents) {
      writeFileAtomic(
        join(stagingDir, document.relativePath),
        renderSourceSpanMarkdown(document),
        fs.renameSync,
      );
    }
    validation = validateStagedNotes(vaultRoot, stagingDir, envelope);
  }

  if (
    validation.report.status !== "pass" ||
    validation.source_span_index === undefined ||
    validation.source_profile === undefined ||
    validation.source_span_count === 0
  ) {
    throw new TransactionPreflightError(validation.report.summary, "STAGED_VALIDATION_FAILED", {
      issues: validation.report.issues,
    });
  }
  return validation;
}

function buildCommittedRecord(
  envelope: ReturnType<typeof loadSourceEnvelope>,
  notePath: string,
  commit: string,
  processedAt: string,
  sourceSpanIndex: SourceSpanIndex,
): SourceRecord {
  return {
    source_key: envelope.source_key,
    kind: envelope.kind,
    origin: envelope.origin,
    content_sha256: envelope.content_sha256,
    contract_version: NOTE_CONTRACT_VERSION,
    status: "committed",
    note_path: notePath,
    commit,
    source_span_index: sourceSpanIndex,
    processed_at: processedAt,
  };
}

function installManagedFiles(
  vaultRoot: string,
  notePath: string,
  stagingDir: string,
  sourceSpanPaths: readonly string[],
  sourceSpanIndex: SourceSpanIndex,
  stalePaths: readonly string[],
  manifest: Manifest,
  logContent: string,
  renameSync: typeof fs.renameSync,
  installedPaths: string[],
): void {
  const root = resolve(vaultRoot);
  const stagedNotePath = join(stagingDir, notePath);
  if (!fs.existsSync(stagedNotePath)) {
    throw new TransactionFailureError(`Staged note missing at ${notePath}`, "STAGED_NOTE_MISSING", {
      path: notePath,
    });
  }

  writeFileAtomic(join(root, notePath), fs.readFileSync(stagedNotePath, "utf8"), renameSync);
  installedPaths.push(notePath);

  for (const sourceSpanPath of sourceSpanPaths) {
    const stagedSourceSpanPath = join(stagingDir, sourceSpanPath);
    if (!fs.existsSync(stagedSourceSpanPath)) {
      throw new TransactionFailureError(
        `Staged source span missing at ${sourceSpanPath}`,
        "STAGED_SOURCE_SPAN_MISSING",
        { path: sourceSpanPath },
      );
    }
    const content = fs.readFileSync(stagedSourceSpanPath, "utf8");
    const indexedSpan = sourceSpanIndex.spans.find((span) => span.path === sourceSpanPath);
    if (indexedSpan === undefined || sourceSpanContentSha256(content) !== indexedSpan.sha256) {
      throw new TransactionFailureError(
        `Staged source span changed after validation at ${sourceSpanPath}`,
        "STAGED_SOURCE_SPAN_CHANGED",
        { path: sourceSpanPath },
      );
    }
    writeFileAtomic(join(root, sourceSpanPath), content, renameSync);
    installedPaths.push(sourceSpanPath);
  }

  const retainedPaths = new Set([notePath, ...sourceSpanPaths]);
  for (const stalePath of stalePaths) {
    if (retainedPaths.has(stalePath)) {
      continue;
    }
    removeIfExists(join(root, stalePath));
    installedPaths.push(stalePath);
  }

  writeFileAtomic(join(root, MANIFEST_RELATIVE_PATH), serializeManifest(manifest), renameSync);
  installedPaths.push(MANIFEST_RELATIVE_PATH);

  writeFileAtomic(join(root, LOG_PATH), logContent, renameSync);
  installedPaths.push(LOG_PATH);
}

function rollbackFailure(
  vaultRoot: string,
  runId: string,
  sourceKey: string,
  phase: TransactionJournal["phase"],
  snapshot: ManagedSnapshot,
  installedPaths: string[],
  error: unknown,
  previousHead?: string,
): never {
  let headRollbackError: string | undefined;
  if (previousHead !== undefined) {
    const currentHead = getHeadCommit(vaultRoot);
    if (currentHead !== previousHead) {
      const restoreHead = runGit(vaultRoot, ["update-ref", "HEAD", previousHead, currentHead]);
      if (restoreHead.status !== 0) {
        headRollbackError =
          restoreHead.stderr || restoreHead.stdout || "git update-ref failed without diagnostics";
      }
    }
  }
  restoreManagedSnapshot(vaultRoot, snapshot);
  removeInstalledNotesAbsentFromSnapshot(vaultRoot, installedPaths, snapshot);
  unstageManagedPaths(vaultRoot, installedPaths);
  const originalMessage = error instanceof Error ? error.message : "Transaction failed";
  const message =
    headRollbackError === undefined
      ? originalMessage
      : `${originalMessage}; failed to restore Git HEAD: ${headRollbackError}`;
  const code =
    headRollbackError !== undefined
      ? "GIT_HEAD_ROLLBACK_FAILED"
      : error instanceof TransactionFailureError
        ? error.code
        : "TRANSACTION_FAILED";
  writeFailureJournal(vaultRoot, {
    schema_version: TRANSACTION_JOURNAL_VERSION,
    run_id: runId,
    source_key: sourceKey,
    phase,
    failed_at: utcNow(),
    error_code: code,
    error_message: message,
    snapshot,
    installed_paths: installedPaths,
  });
  releaseVaultLock(vaultRoot, runId);
  throw new TransactionFailureError(message, code);
}

export function commitStagedSource(input: CommitStagedInput): CommitStagedResult {
  const root = resolve(input.vaultRoot);
  const renameSync = input.hooks?.renameSync ?? fs.renameSync;
  const createCommitHook = input.hooks?.createCommit ?? createCommit;
  const amendCommitHook = input.hooks?.amendCommit ?? amendCommitNoEdit;

  assertVaultReady(root);
  assertNoUnresolvedTransactionState(root, input.runId);

  const stagingDir = stagingPath(root, input.runId);
  if (!fs.existsSync(stagingDir)) {
    throw new TransactionPreflightError(
      `Staging directory does not exist for run '${input.runId}'`,
      "STAGING_NOT_FOUND",
      { run_id: input.runId },
    );
  }

  assertCleanManagedPaths(root);

  const envelope = loadSourceEnvelope(input.envelopePath);
  const manifest = loadManifest(root);
  assertManifestRevision(manifest, input.expectedRevision);

  const inspectOutcome = inspectSource(manifest, envelope.source_key, envelope.content_sha256);
  if (inspectOutcome === "already_processed") {
    throw new TransactionPreflightError(
      `Source '${envelope.source_key}' is already processed`,
      "SOURCE_ALREADY_PROCESSED",
      { source_key: envelope.source_key },
    );
  }
  if (inspectOutcome === "changed_conflict" && input.supersede !== true) {
    throw new TransactionPreflightError(
      `Source '${envelope.source_key}' content hash changed`,
      "SOURCE_CHANGED_CONFLICT",
      { source_key: envelope.source_key, supersede_required: true },
    );
  }

  let validation = validatePreparedStaging(root, stagingDir, envelope);

  input.hooks?.afterValidation?.(root);
  acquireVaultLock(root, input.runId, input.expectedRevision);

  try {
    const currentManifest = loadManifest(root);
    assertManifestRevision(currentManifest, input.expectedRevision);
    assertCleanManagedPaths(root);

    validation = validatePreparedStaging(root, stagingDir, envelope);
    const notePath = validation.staged_paths[0]!;
    const sourceSpanIndex = validation.source_span_index!;
    const existingRecord = currentManifest.sources.find(
      (record) => record.source_key === envelope.source_key,
    );
    const stalePaths =
      input.supersede === true && existingRecord !== undefined
        ? [
            ...(existingRecord.note_path === undefined ? [] : [existingRecord.note_path]),
            ...sourceSpanPathsForRecord(existingRecord),
          ]
        : [];

    const snapshot = captureManagedSnapshot(
      root,
      notePath,
      existingRecord?.note_path === undefined ? [] : [existingRecord.note_path],
    );
    const processedAt = utcNow();
    const logContent = `${snapshot.log}${buildLogEntry(envelope.source_key, notePath, processedAt)}`;
    const pendingManifest = upsertCommittedSource(
      currentManifest,
      buildCommittedRecord(envelope, notePath, PLACEHOLDER_COMMIT, processedAt, sourceSpanIndex),
    );

    updateVaultLockPhase(root, "installing");
    const installedPaths: string[] = [];
    try {
      installManagedFiles(
        root,
        notePath,
        stagingDir,
        validation.source_span_paths,
        sourceSpanIndex,
        stalePaths,
        pendingManifest,
        logContent,
        renameSync,
        installedPaths,
      );
    } catch (error) {
      rollbackFailure(
        root,
        input.runId,
        envelope.source_key,
        "install",
        snapshot,
        installedPaths,
        error,
      );
    }

    updateVaultLockPhase(root, "committing");
    const previousHead = getHeadCommit(root);
    try {
      stageManagedPaths(root, installedPaths);
      const message = `okf-vault: commit ${envelope.source_key}`;
      createCommitHook(root, message);
      let commitHash = getHeadCommit(root);
      const committedManifest = upsertCommittedSource(
        currentManifest,
        buildCommittedRecord(envelope, notePath, commitHash, processedAt, sourceSpanIndex),
      );
      writeFileAtomic(
        join(root, MANIFEST_RELATIVE_PATH),
        serializeManifest(committedManifest),
        renameSync,
      );
      stageManagedPaths(root, [MANIFEST_RELATIVE_PATH]);
      commitHash = amendCommitHook(root);
      const headManifest = readManagedFileFromHead(root, MANIFEST_RELATIVE_PATH);
      if (headManifest !== undefined) {
        writeFileAtomic(join(root, MANIFEST_RELATIVE_PATH), headManifest, renameSync);
      }
    } catch (error) {
      rollbackFailure(
        root,
        input.runId,
        envelope.source_key,
        "commit",
        snapshot,
        installedPaths,
        error,
        previousHead,
      );
    }

    clearFailureJournal(root);
    releaseVaultLock(root, input.runId);
    removeTreeIfExists(stagingDir);

    const finalRevision = manifestRevision(loadManifest(root));
    return {
      run_id: input.runId,
      source_key: envelope.source_key,
      note_path: notePath,
      commit: getHeadCommit(root),
      revision: finalRevision,
      staged_paths: validation.staged_paths,
      source_profile: sourceSpanIndex.profile,
      source_span_count: sourceSpanIndex.spans.length,
      source_span_paths: sourceSpanIndex.spans.map((span) => span.path),
    };
  } catch (error) {
    releaseVaultLock(root, input.runId);
    throw error;
  }
}

/**
 * Removes one committed source from the current tree in a new commit.
 * Historical commits are intentionally left untouched.
 */
export function purgeCommittedSource(input: PurgeCommittedSourceInput): PurgeCommittedSourceResult {
  const root = resolve(input.vaultRoot);
  const sourceKey = input.sourceKey.trim();
  const renameSync = input.hooks?.renameSync ?? fs.renameSync;
  const createCommitHook = input.hooks?.createCommit ?? createCommit;

  if (sourceKey.length === 0) {
    throw new TransactionPreflightError("Source key must be non-empty", "SOURCE_KEY_INVALID");
  }
  assertVaultReady(root);
  assertNoUnresolvedTransactionState(root, input.runId);
  assertCleanManagedPaths(root);

  const manifest = loadManifest(root);
  assertManifestRevision(manifest, input.expectedRevision);
  const initialRecord = manifest.sources.find((record) => record.source_key === sourceKey);
  if (initialRecord?.status !== "committed" || initialRecord.note_path === undefined) {
    throw new TransactionPreflightError(
      `Committed source '${sourceKey}' was not found`,
      "SOURCE_NOT_COMMITTED",
      { source_key: sourceKey },
    );
  }

  acquireVaultLock(root, input.runId, input.expectedRevision);
  try {
    const currentManifest = loadManifest(root);
    assertManifestRevision(currentManifest, input.expectedRevision);
    assertCleanManagedPaths(root);
    const record = currentManifest.sources.find((entry) => entry.source_key === sourceKey);
    if (record?.status !== "committed" || record.note_path === undefined) {
      throw new TransactionPreflightError(
        `Committed source '${sourceKey}' was not found`,
        "SOURCE_NOT_COMMITTED",
        { source_key: sourceKey },
      );
    }

    const snapshot = captureManagedSnapshot(root, record.note_path);
    const removedPaths = [record.note_path, ...sourceSpanPathsForRecord(record)];
    const installedPaths = [...removedPaths, MANIFEST_RELATIVE_PATH, LOG_PATH];
    const processedAt = utcNow();
    const nextManifest = removeSourceRecord(currentManifest, sourceKey);
    const logContent = `${snapshot.log}${buildPurgeLogEntry(
      sourceKey,
      record.note_path,
      processedAt,
    )}`;

    updateVaultLockPhase(root, "installing");
    try {
      for (const relativePath of removedPaths) {
        removeIfExists(join(root, relativePath));
      }
      writeFileAtomic(
        join(root, MANIFEST_RELATIVE_PATH),
        serializeManifest(nextManifest),
        renameSync,
      );
      writeFileAtomic(join(root, LOG_PATH), logContent, renameSync);
    } catch (error) {
      rollbackFailure(root, input.runId, sourceKey, "install", snapshot, installedPaths, error);
    }

    updateVaultLockPhase(root, "committing");
    const previousHead = getHeadCommit(root);
    try {
      stageManagedPaths(root, installedPaths);
      createCommitHook(root, `okf-vault: purge ${sourceKey}`);
    } catch (error) {
      rollbackFailure(
        root,
        input.runId,
        sourceKey,
        "commit",
        snapshot,
        installedPaths,
        error,
        previousHead,
      );
    }

    clearFailureJournal(root);
    releaseVaultLock(root, input.runId);
    return {
      run_id: input.runId,
      source_key: sourceKey,
      removed_paths: removedPaths,
      commit: getHeadCommit(root),
      revision: manifestRevision(loadManifest(root)),
    };
  } catch (error) {
    releaseVaultLock(root, input.runId);
    throw error;
  }
}

export interface RecoverVaultResult {
  recovered: boolean;
  run_id?: string;
  restored_paths: string[];
}

export function recoverVault(vaultRoot: string): RecoverVaultResult {
  const root = resolve(vaultRoot);
  assertVaultReady(root);

  const journal = readTransactionJournal(root);
  const lock = readVaultLock(root);

  if (journal === undefined && lock === undefined) {
    return { recovered: false, restored_paths: [] };
  }

  if (journal !== undefined) {
    restoreManagedSnapshot(root, journal.snapshot);
    removeInstalledNotesAbsentFromSnapshot(root, journal.installed_paths, journal.snapshot);
    unstageManagedPaths(root, journal.installed_paths);
    clearFailureJournal(root);
    releaseVaultLock(root, journal.run_id);
    return {
      recovered: true,
      run_id: journal.run_id,
      restored_paths: journal.installed_paths,
    };
  }

  if (lock !== undefined) {
    releaseVaultLock(root, lock.run_id);
    return {
      recovered: true,
      run_id: lock.run_id,
      restored_paths: [],
    };
  }

  return { recovered: false, restored_paths: [] };
}

export function handleCommit(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  const runId = args[1];
  const envelopePath = args[2];
  const expectedRevision = args[3];
  const mode = args[4];

  if (
    vaultRoot === undefined ||
    runId === undefined ||
    envelopePath === undefined ||
    expectedRevision === undefined ||
    args.length > 5 ||
    (mode !== undefined && mode !== "--supersede")
  ) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "commit",
        "USAGE_MISSING_ARGS",
        "Usage: commit <vault-root> <run-id> <envelope-json-path> <expected-manifest-revision> [--supersede]",
      ),
      diagnostic: "Missing required arguments for commit.",
    };
  }

  try {
    const data = commitStagedSource({
      vaultRoot,
      runId,
      envelopePath,
      expectedRevision,
      ...(mode === "--supersede" ? { supersede: true } : {}),
    });
    return {
      exitCode: ExitCode.SUCCESS,
      result: success("commit", { ...data }),
    };
  } catch (error) {
    if (error instanceof TransactionPreflightError) {
      const exitCode =
        error.code === "STAGED_VALIDATION_FAILED" ? ExitCode.VALIDATION : ExitCode.CONFLICT;
      return {
        exitCode,
        result: failure("commit", error.code, error.message, error.details),
        diagnostic: error.message,
      };
    }
    if (error instanceof VaultLockError) {
      return {
        exitCode: ExitCode.CONFLICT,
        result: failure("commit", "VAULT_LOCKED", error.message),
        diagnostic: error.message,
      };
    }
    if (error instanceof ManifestRevisionMismatchError) {
      return {
        exitCode: ExitCode.CONFLICT,
        result: failure("commit", "MANIFEST_REVISION_MISMATCH", error.message, {
          expected: error.expected,
          actual: error.actual,
        }),
        diagnostic: error.message,
      };
    }
    if (error instanceof TransactionFailureError) {
      return {
        exitCode: ExitCode.TRANSACTION,
        result: failure("commit", error.code, error.message, error.details),
        diagnostic: error.message,
      };
    }
    const message = error instanceof Error ? error.message : "Commit failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("commit", "COMMIT_FAILED", message),
      diagnostic: message,
    };
  }
}

export function handleRecover(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("recover", "USAGE_MISSING_ARGS", "Usage: recover <vault-root>"),
      diagnostic: "Missing required argument for recover.",
    };
  }

  try {
    const data = recoverVault(vaultRoot);
    return {
      exitCode: ExitCode.SUCCESS,
      result: success("recover", { ...data }),
    };
  } catch (error) {
    if (error instanceof TransactionPreflightError) {
      const exitCode =
        error.code === "MANAGED_PATH_CONFLICT" ? ExitCode.CONFLICT : ExitCode.TRANSACTION;
      return {
        exitCode,
        result: failure("recover", error.code, error.message, error.details),
        diagnostic: error.message,
      };
    }
    const message = error instanceof Error ? error.message : "Recovery failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("recover", "RECOVER_FAILED", message),
      diagnostic: message,
    };
  }
}

export function restoreManagedPathsFromHead(vaultRoot: string, paths: readonly string[]): void {
  for (const relativePath of paths) {
    const content = readManagedFileFromHead(vaultRoot, relativePath);
    const fullPath = join(resolve(vaultRoot), relativePath);
    if (content === undefined) {
      removeIfExists(fullPath);
      continue;
    }
    writeFileAtomic(fullPath, content, fs.renameSync);
  }
}
