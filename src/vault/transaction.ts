import * as fs from "node:fs";
import { dirname, join, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli.js";
import {
  JOURNAL_RELATIVE_PATH,
  LOCK_RELATIVE_PATH,
  LOG_PATH,
  MANIFEST_RELATIVE_PATH,
  NOTE_CONTRACT_VERSION,
  TMP_DIR,
} from "./constants.js";
import {
  amendCommitNoEdit,
  createCommit,
  getHeadCommit,
  getManagedPathStatus,
  isGitRepository,
  readManagedFileFromHead,
  stageManagedPaths,
} from "./git.js";
import {
  assertManifestRevision,
  inspectSource,
  loadManifest,
  ManifestRevisionMismatchError,
  manifestRevision,
  serializeManifest,
  upsertCommittedSource,
  utcNow,
  type Manifest,
  type SourceRecord,
} from "./manifest.js";
import { loadSourceEnvelope, validateStagedNotes } from "./validation.js";

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
  hooks?: TransactionHooks;
}

export interface CommitStagedResult {
  run_id: string;
  source_key: string;
  note_path: string;
  commit: string;
  revision: string;
  staged_paths: string[];
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

export function captureManagedSnapshot(vaultRoot: string, notePath: string): ManagedSnapshot {
  const root = resolve(vaultRoot);
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  const logFilePath = join(root, LOG_PATH);
  const notes: Record<string, string> = {};

  const noteFullPath = join(root, notePath);
  if (fs.existsSync(noteFullPath)) {
    notes[notePath] = fs.readFileSync(noteFullPath, "utf8");
  }

  return {
    manifest: fs.readFileSync(manifestPath, "utf8"),
    log: fs.readFileSync(logFilePath, "utf8"),
    notes,
  };
}

export function restoreManagedSnapshot(vaultRoot: string, snapshot: ManagedSnapshot): void {
  const root = resolve(vaultRoot);
  writeFileAtomic(join(root, MANIFEST_RELATIVE_PATH), snapshot.manifest, fs.renameSync);
  writeFileAtomic(join(root, LOG_PATH), snapshot.log, fs.renameSync);

  for (const [relativePath, content] of Object.entries(snapshot.notes)) {
    writeFileAtomic(join(root, relativePath), content, fs.renameSync);
  }

  const installedNotePaths = fs
    .readdirSync(join(root, "notes"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name !== "index.md")
    .map((entry) => join("notes", entry.name).split("\\").join("/"));

  for (const relativePath of installedNotePaths) {
    if (!(relativePath in snapshot.notes)) {
      removeIfExists(join(root, relativePath));
    }
  }
}

export function writeFailureJournal(vaultRoot: string, journal: TransactionJournal): void {
  writeJsonAtomic(journalPath(vaultRoot), journal);
}

export function clearFailureJournal(vaultRoot: string): void {
  removeIfExists(journalPath(vaultRoot));
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

function buildCommittedRecord(
  envelope: ReturnType<typeof loadSourceEnvelope>,
  notePath: string,
  commit: string,
  processedAt: string,
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
    processed_at: processedAt,
  };
}

function installManagedFiles(
  vaultRoot: string,
  notePath: string,
  stagingDir: string,
  manifest: Manifest,
  logContent: string,
  renameSync: typeof fs.renameSync,
): string[] {
  const root = resolve(vaultRoot);
  const stagedNotePath = join(stagingDir, notePath);
  if (!fs.existsSync(stagedNotePath)) {
    throw new TransactionFailureError(`Staged note missing at ${notePath}`, "STAGED_NOTE_MISSING", {
      path: notePath,
    });
  }

  const installedPaths: string[] = [];
  writeFileAtomic(join(root, notePath), fs.readFileSync(stagedNotePath, "utf8"), renameSync);
  installedPaths.push(notePath);

  writeFileAtomic(join(root, MANIFEST_RELATIVE_PATH), serializeManifest(manifest), renameSync);
  installedPaths.push(MANIFEST_RELATIVE_PATH);

  writeFileAtomic(join(root, LOG_PATH), logContent, renameSync);
  installedPaths.push(LOG_PATH);

  return installedPaths;
}

function rollbackFailure(
  vaultRoot: string,
  runId: string,
  sourceKey: string,
  phase: TransactionJournal["phase"],
  snapshot: ManagedSnapshot,
  installedPaths: string[],
  error: unknown,
): never {
  restoreManagedSnapshot(vaultRoot, snapshot);
  const message = error instanceof Error ? error.message : "Transaction failed";
  const code = error instanceof TransactionFailureError ? error.code : "TRANSACTION_FAILED";
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
  if (inspectOutcome === "changed_conflict") {
    throw new TransactionPreflightError(
      `Source '${envelope.source_key}' content hash changed`,
      "SOURCE_CHANGED_CONFLICT",
      { source_key: envelope.source_key },
    );
  }

  const validation = validateStagedNotes(root, stagingDir, envelope);
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

  input.hooks?.afterValidation?.(root);

  const notePath = validation.staged_paths[0]!;
  acquireVaultLock(root, input.runId, input.expectedRevision);

  try {
    const currentManifest = loadManifest(root);
    assertManifestRevision(currentManifest, input.expectedRevision);
    assertCleanManagedPaths(root);

    const snapshot = captureManagedSnapshot(root, notePath);
    const processedAt = utcNow();
    const logContent = `${snapshot.log}${buildLogEntry(envelope.source_key, notePath, processedAt)}`;
    const pendingManifest = upsertCommittedSource(
      currentManifest,
      buildCommittedRecord(envelope, notePath, PLACEHOLDER_COMMIT, processedAt),
    );

    updateVaultLockPhase(root, "installing");
    let installedPaths: string[] = [];
    try {
      installedPaths = installManagedFiles(
        root,
        notePath,
        stagingDir,
        pendingManifest,
        logContent,
        renameSync,
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
    try {
      stageManagedPaths(root, installedPaths);
      const message = `okf-vault: commit ${envelope.source_key}`;
      createCommitHook(root, message);
      let commitHash = getHeadCommit(root);
      let committedManifest = upsertCommittedSource(
        currentManifest,
        buildCommittedRecord(envelope, notePath, commitHash, processedAt),
      );
      writeFileAtomic(
        join(root, MANIFEST_RELATIVE_PATH),
        serializeManifest(committedManifest),
        renameSync,
      );
      stageManagedPaths(root, [MANIFEST_RELATIVE_PATH]);
      commitHash = amendCommitHook(root);
      committedManifest = upsertCommittedSource(
        currentManifest,
        buildCommittedRecord(envelope, notePath, commitHash, processedAt),
      );
      writeFileAtomic(
        join(root, MANIFEST_RELATIVE_PATH),
        serializeManifest(committedManifest),
        renameSync,
      );
    } catch (error) {
      rollbackFailure(
        root,
        input.runId,
        envelope.source_key,
        "commit",
        snapshot,
        installedPaths,
        error,
      );
    }

    clearFailureJournal(root);
    releaseVaultLock(root, input.runId);

    const finalRevision = manifestRevision(loadManifest(root));
    return {
      run_id: input.runId,
      source_key: envelope.source_key,
      note_path: notePath,
      commit: getHeadCommit(root),
      revision: finalRevision,
      staged_paths: validation.staged_paths,
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
    for (const relativePath of journal.installed_paths) {
      if (!(relativePath in journal.snapshot.notes) && relativePath.startsWith("notes/")) {
        removeIfExists(join(root, relativePath));
      }
    }
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

  if (
    vaultRoot === undefined ||
    runId === undefined ||
    envelopePath === undefined ||
    expectedRevision === undefined
  ) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure(
        "commit",
        "USAGE_MISSING_ARGS",
        "Usage: commit <vault-root> <run-id> <envelope-json-path> <expected-manifest-revision>",
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
