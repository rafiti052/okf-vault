import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_RELATIVE_PATH, NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  deriveSourceKey,
  inspectSource,
  loadManifest,
  manifestRevision,
  saveManifest,
  serializeManifest,
  validateSourceRecord,
  createEmptyManifest,
  ManifestValidationError,
  type SourceRecord,
} from "../../dist/vault/manifest.js";
const VALID_SHA = "a".repeat(64);
const VALID_SHA_B = "b".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function committedRecord(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    source_key: "local:/tmp/article.md",
    kind: "local",
    origin: "/tmp/article.md",
    content_sha256: VALID_SHA,
    contract_version: NOTE_CONTRACT_VERSION,
    status: "committed",
    note_path: "notes/article.md",
    commit: "abc1234",
    processed_at: VALID_TS,
    ...overrides,
  };
}

describe("manifest source identity and serialization", () => {
  it("maps equivalent normalized local paths to one key", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-keys-"));
    const clean = join(vaultRoot, "docs", "article.md");
    const messy = join(vaultRoot, ".", "docs", "article.md");
    const keyFromClean = deriveSourceKey("local", clean);
    const keyFromMessy = deriveSourceKey("local", messy);
    assert.equal(keyFromMessy, keyFromClean);
    assert.match(keyFromClean, /^local:/);
  });

  it("keeps Drive and Granola provider IDs distinct and qualified", () => {
    const driveKey = deriveSourceKey("google_drive", "file-abc123");
    const granolaKey = deriveSourceKey("granola", "meeting-xyz");
    assert.equal(driveKey, "drive:file-abc123");
    assert.equal(granolaKey, "granola:meeting-xyz");
    assert.notEqual(driveKey, granolaKey);
  });

  it("serializes sources in stable key order regardless of insertion order", () => {
    const recordA = committedRecord({ source_key: "drive:a", kind: "google_drive", origin: "a" });
    const recordB = committedRecord({
      source_key: "local:/tmp/z.md",
      kind: "local",
      origin: "/tmp/z.md",
    });
    const first = serializeManifest({
      ...createEmptyManifest(),
      sources: [recordB, recordA],
    });
    const second = serializeManifest({
      ...createEmptyManifest(),
      sources: [recordA, recordB],
    });
    assert.equal(first, second);
  });
});

describe("manifest inspection and invariants", () => {
  it("returns new, already-processed, and changed-conflict outcomes without mutation", () => {
    const manifest = createEmptyManifest();
    const key = deriveSourceKey("local", "/tmp/article.md");
    assert.equal(inspectSource(manifest, key, VALID_SHA), "new");

    const committed = committedRecord({ source_key: key, content_sha256: VALID_SHA });
    const withRecord = { ...manifest, sources: [committed] };
    assert.equal(inspectSource(withRecord, key, VALID_SHA), "already_processed");
    assert.equal(inspectSource(withRecord, key, VALID_SHA_B), "changed_conflict");
    assert.equal(withRecord.sources[0]!.content_sha256, VALID_SHA);
  });

  it("rejects committed records without note or commit references", () => {
    const missingNote = committedRecord();
    delete missingNote.note_path;
    assert.throws(() => validateSourceRecord(missingNote), ManifestValidationError);

    const missingCommit = committedRecord();
    delete missingCommit.commit;
    assert.throws(() => validateSourceRecord(missingCommit), ManifestValidationError);
  });

  it("rejects skipped records without reasons and failed statuses", () => {
    const missingReason = committedRecord({
      status: "skipped",
      skip_reason: "",
    });
    delete missingReason.note_path;
    delete missingReason.commit;
    assert.throws(() => validateSourceRecord(missingReason), ManifestValidationError);
    assert.throws(
      () =>
        validateSourceRecord(
          committedRecord({
            status: "failed" as never,
          }),
        ),
      ManifestValidationError,
    );
  });

  it("rejects unsupported schema and contract versions", () => {
    assert.throws(
      () =>
        saveManifest(mkdtempSync(join(tmpdir(), "okf-manifest-")), {
          schema_version: "okf-vault-manifest/9.9.9" as never,
          note_contract_version: NOTE_CONTRACT_VERSION,
          sources: [],
        }),
      ManifestValidationError,
    );
    assert.throws(
      () => validateSourceRecord(committedRecord({ contract_version: "okf-note-contract/9.9.9" })),
      ManifestValidationError,
    );
  });

  it("leaves the prior manifest unchanged when persistence fails before atomic rename", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-atomic-"));
    mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
    const manifest = createEmptyManifest();
    saveManifest(vaultRoot, manifest);
    const before = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");

    const invalidRecord = committedRecord();
    delete invalidRecord.note_path;
    assert.throws(
      () =>
        saveManifest(vaultRoot, {
          ...manifest,
          sources: [invalidRecord],
        }),
      ManifestValidationError,
    );

    const after = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    assert.equal(after, before);
  });

  it("leaves the prior manifest unchanged when atomic rename fails", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-rename-"));
    const vaultDir = join(vaultRoot, ".okf-vault");
    mkdirSync(vaultDir, { recursive: true });
    const manifest = createEmptyManifest();
    saveManifest(vaultRoot, manifest);
    const before = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");

    chmodSync(vaultDir, 0o555);
    try {
      assert.throws(() =>
        saveManifest(vaultRoot, {
          ...manifest,
          sources: [committedRecord()],
        }),
      );
    } finally {
      chmodSync(vaultDir, 0o755);
    }

    const after = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    assert.equal(after, before);
  });

  it("exposes a stable revision for lock-time revalidation", () => {
    const manifest = createEmptyManifest();
    const revision = manifestRevision(manifest);
    assert.match(revision, /^[a-f0-9]{64}$/);
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-rev-"));
    saveManifest(vaultRoot, manifest);
    assert.equal(revision, manifestRevision(loadManifest(vaultRoot)));
  });
});
