import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  type SourceSpanIndex,
  type SourceSpanProfile,
  type SourceSpanRef,
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

function sourceSpanIndex(overrides: Partial<SourceSpanIndex> = {}): SourceSpanIndex {
  return {
    schema_version: "okf-source-spans/1.0.0",
    profile: "article",
    default_expansion: { previous: 1, next: 1 },
    spans: [
      {
        id: "span-001",
        path: "references/sources/article/span-001.md",
        sha256: VALID_SHA_B,
        profile: "article",
        sequence: 1,
        anchor_ids: ["anchor-001"],
      },
    ],
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

  it("derives stable youtube keys from video IDs and common URL variants", () => {
    const videoId = "dQw4w9WgXcQ";
    const expected = `youtube:${videoId}`;
    const origins = [
      videoId,
      `youtube:${videoId}`,
      `https://www.youtube.com/watch?v=${videoId}`,
      `https://youtube.com/watch?v=${videoId}&t=42`,
      `https://youtu.be/${videoId}`,
      `https://www.youtube.com/embed/${videoId}`,
      `https://www.youtube.com/shorts/${videoId}`,
      `https://m.youtube.com/watch?v=${videoId}`,
    ];
    for (const origin of origins) {
      assert.equal(deriveSourceKey("youtube", origin), expected, origin);
    }
  });

  it("rejects malformed YouTube origins during key derivation", () => {
    assert.throws(() => deriveSourceKey("youtube", ""), /Invalid YouTube origin/);
    assert.throws(() => deriveSourceKey("youtube", "not-a-valid-id"), /Invalid YouTube origin/);
    assert.throws(
      () => deriveSourceKey("youtube", "https://www.youtube.com/watch?v=tooshort"),
      /Invalid YouTube origin/,
    );
    assert.throws(
      () => deriveSourceKey("youtube", "https://example.com/watch?v=dQw4w9WgXcQ"),
      /Invalid YouTube origin/,
    );
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

  it("canonicalizes source spans and anchor coverage deterministically", () => {
    const firstSpan: SourceSpanRef = {
      id: "span-001",
      path: "references/sources/article/span-001.md",
      sha256: VALID_SHA,
      profile: "article",
      sequence: 1,
      anchor_ids: ["anchor-b", "anchor-a"],
      next_id: "span-002",
    };
    const secondSpan: SourceSpanRef = {
      id: "span-002",
      path: "references/sources/article/span-002.md",
      sha256: VALID_SHA_B,
      profile: "article",
      sequence: 2,
      anchor_ids: ["anchor-c"],
      prev_id: "span-001",
    };
    const first = serializeManifest({
      ...createEmptyManifest(),
      sources: [
        committedRecord({
          source_span_index: sourceSpanIndex({ spans: [secondSpan, firstSpan] }),
        }),
      ],
    });
    const second = serializeManifest({
      ...createEmptyManifest(),
      sources: [
        committedRecord({
          source_span_index: sourceSpanIndex({
            spans: [{ ...firstSpan, anchor_ids: [...firstSpan.anchor_ids].reverse() }, secondSpan],
          }),
        }),
      ],
    });

    assert.equal(first, second);
    const parsed = JSON.parse(first) as { sources: SourceRecord[] };
    assert.deepEqual(parsed.sources[0]?.source_span_index?.spans[0]?.anchor_ids, [
      "anchor-a",
      "anchor-b",
    ]);
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

  it("accepts committed and skipped youtube source records", () => {
    const videoId = "dQw4w9WgXcQ";
    const sourceKey = deriveSourceKey("youtube", videoId);
    const committed = committedRecord({
      source_key: sourceKey,
      kind: "youtube",
      origin: videoId,
      note_path: "notes/youtube-video.md",
    });
    validateSourceRecord(committed);

    const skipped = committedRecord({
      source_key: sourceKey,
      kind: "youtube",
      origin: `https://www.youtube.com/watch?v=${videoId}`,
      status: "skipped",
      skip_reason: "curator declined",
    });
    delete skipped.note_path;
    delete skipped.commit;
    validateSourceRecord(skipped);
  });

  it("round-trips valid source-span index metadata through save and load", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-span-roundtrip-"));
    const manifest = {
      ...createEmptyManifest(),
      sources: [committedRecord({ source_span_index: sourceSpanIndex() })],
    };

    saveManifest(vaultRoot, manifest);

    assert.deepEqual(loadManifest(vaultRoot), manifest);
    const serialized = readFileSync(join(vaultRoot, MANIFEST_RELATIVE_PATH), "utf8");
    assert.match(serialized, /"path": "references\/sources\/article\/span-001\.md"/);
    assert.doesNotMatch(serialized, /source text|full_text|"text"/);
  });

  it("rejects unknown or inconsistent source-span schema versions and profiles", () => {
    const badVersion = sourceSpanIndex();
    (badVersion as unknown as { schema_version: string }).schema_version = "okf-source-spans/9.9.9";
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: badVersion })),
      ManifestValidationError,
    );

    const badProfile = sourceSpanIndex();
    (badProfile as unknown as { profile: string }).profile = "podcast";
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: badProfile })),
      ManifestValidationError,
    );

    const mismatchedProfile = sourceSpanIndex();
    mismatchedProfile.spans[0]!.profile = "video";
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: mismatchedProfile })),
      ManifestValidationError,
    );
  });

  it("accepts source-span indexes for every current conversion profile", () => {
    const profiles: SourceSpanProfile[] = ["article", "video", "panel", "deck"];

    for (const profile of profiles) {
      const index = sourceSpanIndex({
        profile,
        spans: sourceSpanIndex().spans.map((span) => ({ ...span, profile })),
      });
      validateSourceRecord(committedRecord({ source_span_index: index }));
    }
  });

  it("rejects missing or malformed source-span hashes and anchor coverage", () => {
    const missingHash = sourceSpanIndex();
    delete (missingHash.spans[0] as Partial<SourceSpanRef>).sha256;
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: missingHash })),
      ManifestValidationError,
    );

    const malformedHash = sourceSpanIndex();
    malformedHash.spans[0]!.sha256 = "not-a-sha256";
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: malformedHash })),
      ManifestValidationError,
    );

    const missingAnchors = sourceSpanIndex();
    delete (missingAnchors.spans[0] as Partial<SourceSpanRef>).anchor_ids;
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: missingAnchors })),
      ManifestValidationError,
    );
  });

  it("fails closed when loading source-span paths outside the managed references tree", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-span-path-"));
    const manifest = {
      ...createEmptyManifest(),
      sources: [
        committedRecord({
          source_span_index: sourceSpanIndex({
            spans: [
              {
                ...sourceSpanIndex().spans[0]!,
                path: "references/sources/article/../../notes/private.md",
              },
            ],
          }),
        }),
      ],
    };
    const manifestPath = join(vaultRoot, MANIFEST_RELATIVE_PATH);
    mkdirSync(join(vaultRoot, ".okf-vault"), { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    assert.throws(() => loadManifest(vaultRoot), ManifestValidationError);
  });

  it("rejects embedded source text, unknown metadata, and span indexes on skipped records", () => {
    const embeddedText = sourceSpanIndex();
    (embeddedText.spans[0] as SourceSpanRef & { text?: string }).text = "raw evidence";
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: embeddedText })),
      ManifestValidationError,
    );

    const unboundedExpansion = sourceSpanIndex();
    (
      unboundedExpansion.default_expansion as unknown as {
        previous: number;
        next: number;
      }
    ).previous = 2;
    assert.throws(
      () => validateSourceRecord(committedRecord({ source_span_index: unboundedExpansion })),
      ManifestValidationError,
    );

    const skipped = committedRecord({
      status: "skipped",
      skip_reason: "curator declined",
      source_span_index: sourceSpanIndex(),
    });
    delete skipped.note_path;
    delete skipped.commit;
    assert.throws(() => validateSourceRecord(skipped), ManifestValidationError);
  });
});
