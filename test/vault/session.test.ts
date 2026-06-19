import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { parseIngestRunInput } from "../../dist/vault/ingestion.js";
import {
  createDefaultSessionContext,
  INGEST_WIZARD_STEPS,
  parseVaultSessionContext,
  resolveVaultRoot,
  SESSION_EXIT_STATUSES,
  SESSION_SOURCE_KINDS,
  SessionContextError,
  SKILL_MODES,
  type IngestWizardState,
  type VaultSessionContext,
} from "../../dist/vault/session.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const resolveFixturesRoot = join(root, "test", "fixtures", "vaults", "resolve");

describe("resolveVaultRoot", () => {
  it("returns found with vault_root ending in knowledge when knowledge manifest exists", () => {
    const repoRoot = join(resolveFixturesRoot, "knowledge-initialized");
    const result = resolveVaultRoot(repoRoot);

    assert.equal(result.status, "found");
    assert.ok(result.vault_root);
    assert.ok(result.vault_root.endsWith("knowledge"));
    assert.equal(result.vault_root, join(repoRoot, "knowledge"));
  });

  it("returns not_initialized when neither knowledge manifest nor legacy marker exists", () => {
    const repoRoot = join(resolveFixturesRoot, "missing");
    const result = resolveVaultRoot(repoRoot);

    assert.deepEqual(result, {
      status: "not_initialized",
      vault_root: null,
    });
  });

  it("returns found via legacy repo-root marker when knowledge layout is absent", () => {
    const repoRoot = join(resolveFixturesRoot, "legacy-root");
    const result = resolveVaultRoot(repoRoot);

    assert.equal(result.status, "found");
    assert.equal(result.vault_root, repoRoot);
  });

  it("prefers knowledge layout when both knowledge manifest and legacy marker exist", () => {
    const repoRoot = join(resolveFixturesRoot, "both-markers");
    const result = resolveVaultRoot(repoRoot);

    assert.equal(result.status, "found");
    assert.equal(result.vault_root, join(repoRoot, "knowledge"));
    assert.notEqual(result.vault_root, repoRoot);
  });

  it("returns not_initialized for a nonexistent repo root without throwing", () => {
    const result = resolveVaultRoot("/nonexistent");

    assert.deepEqual(result, {
      status: "not_initialized",
      vault_root: null,
    });
  });
});

describe("resolveVaultRoot session integration", () => {
  it("creates default session context from resolved knowledge vault root", () => {
    const repoRoot = join(resolveFixturesRoot, "knowledge-initialized");
    const resolved = resolveVaultRoot(repoRoot);

    assert.equal(resolved.status, "found");
    assert.ok(resolved.vault_root);

    const context = createDefaultSessionContext(resolved.vault_root);
    assert.equal(context.vault_root, resolved.vault_root);
    assert.deepEqual(context, {
      vault_root: join(repoRoot, "knowledge"),
      last_run_id: null,
      last_mode: null,
      last_exit_status: null,
      last_source_kind: null,
    } satisfies VaultSessionContext);
  });
});

describe("parseVaultSessionContext", () => {
  it("accepts a fully populated context with all SkillMode and SessionExitStatus enum values", () => {
    for (const last_mode of SKILL_MODES) {
      for (const last_exit_status of SESSION_EXIT_STATUSES) {
        for (const last_source_kind of SESSION_SOURCE_KINDS) {
          const parsed = parseVaultSessionContext({
            vault_root: "knowledge",
            last_run_id: `run-${last_mode}-${last_exit_status}`,
            last_mode,
            last_exit_status,
            last_source_kind,
          });

          assert.equal(parsed.vault_root, "knowledge");
          assert.equal(parsed.last_mode, last_mode);
          assert.equal(parsed.last_exit_status, last_exit_status);
          assert.equal(parsed.last_source_kind, last_source_kind);
        }
      }
    }
  });

  it("rejects non-object input", () => {
    assert.throws(
      () => parseVaultSessionContext(null),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_CONTEXT_SHAPE",
    );
    assert.throws(
      () => parseVaultSessionContext([]),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_CONTEXT_SHAPE",
    );
  });

  it("rejects missing vault_root", () => {
    assert.throws(
      () =>
        parseVaultSessionContext({
          last_run_id: null,
          last_mode: null,
          last_exit_status: null,
          last_source_kind: null,
        }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "MISSING_VAULT_ROOT",
    );
  });

  it("rejects empty or whitespace vault_root", () => {
    assert.throws(
      () =>
        parseVaultSessionContext({
          vault_root: "",
          last_run_id: null,
          last_mode: null,
          last_exit_status: null,
          last_source_kind: null,
        }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_VAULT_ROOT",
    );
    assert.throws(
      () =>
        parseVaultSessionContext({
          vault_root: "   ",
          last_run_id: null,
          last_mode: null,
          last_exit_status: null,
          last_source_kind: null,
        }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_VAULT_ROOT",
    );
  });

  it("rejects invalid last_mode, last_exit_status, and last_source_kind", () => {
    const base = {
      vault_root: "knowledge",
      last_run_id: null,
      last_exit_status: null,
      last_source_kind: null,
    };

    assert.throws(
      () => parseVaultSessionContext({ ...base, last_mode: "bootstrap" }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_ENUM_VALUE",
    );
    assert.throws(
      () => parseVaultSessionContext({ ...base, last_exit_status: "pending" }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_ENUM_VALUE",
    );
    assert.throws(
      () => parseVaultSessionContext({ ...base, last_source_kind: "dropbox" }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_ENUM_VALUE",
    );
  });

  it("rejects non-string nullable fields", () => {
    assert.throws(
      () =>
        parseVaultSessionContext({
          vault_root: "knowledge",
          last_run_id: 42,
          last_mode: null,
          last_exit_status: null,
          last_source_kind: null,
        }),
      (error: unknown) =>
        error instanceof SessionContextError && error.code === "INVALID_FIELD_TYPE",
    );
  });

  it("trims vault_root whitespace", () => {
    const parsed = parseVaultSessionContext({
      vault_root: "  knowledge  ",
      last_run_id: null,
      last_mode: null,
      last_exit_status: null,
      last_source_kind: null,
    });
    assert.equal(parsed.vault_root, "knowledge");
  });
});

describe("createDefaultSessionContext", () => {
  it("returns null last_run_id, last_mode, last_exit_status, and last_source_kind", () => {
    const context = createDefaultSessionContext("knowledge");
    assert.deepEqual(context, {
      vault_root: "knowledge",
      last_run_id: null,
      last_mode: null,
      last_exit_status: null,
      last_source_kind: null,
    } satisfies VaultSessionContext);
  });
});

describe("IngestWizardState contract", () => {
  it("includes all seven wizard steps", () => {
    assert.deepEqual(
      [...INGEST_WIZARD_STEPS],
      [
        "resolve_vault",
        "choose_source_type",
        "acquire_mcp",
        "acquire_local",
        "confirm_source",
        "delegate_ingest",
        "post_commit",
      ],
    );
  });

  it("accepts pending_source with kind, locator, and content_type", () => {
    const wizardState: IngestWizardState = {
      step: "confirm_source",
      source_type: "local_file",
      pending_source: {
        kind: "local",
        locator: "/tmp/sources/article.md",
        content_type: "text/markdown",
      },
      run_id: "run-wizard-01",
    };

    assert.equal(wizardState.pending_source?.kind, "local");
    assert.equal(wizardState.pending_source?.locator, "/tmp/sources/article.md");
    assert.equal(wizardState.pending_source?.content_type, "text/markdown");
  });
});

describe("wizard handoff integration", () => {
  it("passes parseIngestRunInput when pending_source is wrapped in a single-element sources array", () => {
    const wizardState: IngestWizardState = {
      step: "delegate_ingest",
      source_type: "mcp_artifact",
      pending_source: {
        kind: "google_drive",
        locator: "drive:doc-123",
        content_type: "application/vnd.google-apps.document",
      },
      run_id: "run-handoff-01",
    };

    assert.ok(wizardState.pending_source);

    const handoff = parseIngestRunInput({
      vault_root: "knowledge",
      run_id: wizardState.run_id,
      sources: [wizardState.pending_source],
    });

    assert.equal(handoff.run_id, "run-handoff-01");
    assert.equal(handoff.sources.length, 1);
    assert.equal(handoff.sources[0]?.kind, "google_drive");
  });
});
