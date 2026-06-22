import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const schemasDir = join(root, "schemas");
const refsDir = join(root, ".agents", "skills", "okf-vault", "references");

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function createValidator(schemaFile) {
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateSchema: true });
  addFormats(ajv);
  const schema = loadJson(join(schemasDir, schemaFile));
  return { schema, validate: ajv.compile(schema) };
}

const NOTE_TYPES = [
  "Article Note",
  "Slide Deck Note",
  "Panel Transcript Note",
  "Video Transcript Note",
  "Topic Map",
];

const MANDATORY_SECTIONS = ["# Summary", "# Key Claims", "# Citations", "# Evidence"];
const DECK_SECTIONS = ["# Narrative", "# Slide Coverage"];

const VALID_SHA = "a".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

describe("JSON Schema contracts", () => {
  it("manifest schema declares versioned identifier and fail-closed boundaries", () => {
    const { schema, validate } = createValidator("manifest.schema.json");
    assert.equal(schema.$id, "okf-vault-manifest/1.0.0");
    assert.ok(
      validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/2.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [],
        extra: true,
      }),
    );
  });

  it("rejects missing contract versions, empty source keys, bad SHA-256, unknown statuses, skipped without reason", () => {
    const { validate } = createValidator("manifest.schema.json");
    const base = {
      source_key: "local:/tmp/article.md",
      kind: "local",
      origin: "/tmp/article.md",
      content_sha256: VALID_SHA,
      contract_version: "okf-note-contract/1.0.0",
      status: "committed",
      note_path: "notes/article.md",
      commit: "abc1234",
      processed_at: VALID_TS,
    };
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "unknown/9.9.9",
        sources: [base],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [{ ...base, source_key: "" }],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [{ ...base, content_sha256: "not-a-hash" }],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [{ ...base, status: "failed" }],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [{ ...base, status: "skipped" }],
      }),
    );
    assert.ok(
      validate({
        schema_version: "okf-vault-manifest/1.0.0",
        note_contract_version: "okf-note-contract/1.0.0",
        sources: [
          {
            ...base,
            status: "skipped",
            skip_reason: "curator declined",
            note_path: undefined,
            commit: undefined,
          },
        ],
      }),
    );
  });

  it("proposal schema validates topic, link, duplicate, contradiction with claim ID rules", () => {
    const { schema, validate } = createValidator("proposal.schema.json");
    assert.equal(schema.$id, "okf-vault-proposal/1.0.0");
    const base = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-001",
      affected_paths: ["notes/a.md"],
      rationale: "related topics",
      confidence: "medium",
      disposition: "pending",
    };
    for (const type of ["topic", "link", "duplicate", "contradiction"]) {
      const proposal = { ...base, type };
      if (type === "duplicate" || type === "contradiction") {
        proposal.claim_ids = ["claim-001", "claim-002"];
      }
      assert.ok(validate(proposal), `expected ${type} proposal to validate`);
    }
    assert.ok(!validate({ ...base, type: "duplicate" }));
    assert.ok(!validate({ ...base, type: "contradiction", claim_ids: [] }));
  });

  it("validation report requires status, version, and stable error codes", () => {
    const { validate } = createValidator("validation-report.schema.json");
    assert.ok(
      validate({
        schema_version: "okf-vault-validation-report/1.0.0",
        contract_version: "okf-note-contract/1.0.0",
        status: "pass",
        summary: "All checks passed.",
        issues: [],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-validation-report/1.0.0",
        contract_version: "okf-note-contract/1.0.0",
        summary: "missing status",
        issues: [],
      }),
    );
    assert.ok(
      !validate({
        schema_version: "okf-vault-validation-report/1.0.0",
        contract_version: "okf-note-contract/1.0.0",
        status: "fail",
        summary: "bad code",
        issues: [{ code: "bad", message: "lower case" }],
      }),
    );
    assert.ok(
      validate({
        schema_version: "okf-vault-validation-report/1.0.0",
        contract_version: "okf-note-contract/1.0.0",
        status: "fail",
        summary: "One issue found.",
        issues: [{ code: "MISSING_SECTION", message: "Missing # Summary", path: "notes/x.md" }],
      }),
    );
  });
});

describe("Contract reference documents", () => {
  it("note contract lists every allowed note type and mandatory section", () => {
    const text = readFileSync(join(refsDir, "note-contract.md"), "utf8");
    for (const type of NOTE_TYPES) {
      assert.match(text, new RegExp(type.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const section of MANDATORY_SECTIONS) {
      assert.match(text, new RegExp(section.replace("#", "\\#")));
    }
    for (const section of DECK_SECTIONS) {
      assert.match(text, new RegExp(section.replace("#", "\\#")));
    }
    assert.doesNotMatch(text, /mcp_|claude_|codex_/i);
  });

  it("vault layout documents populated indexes and credential prohibition", () => {
    const text = readFileSync(join(refsDir, "vault-layout.md"), "utf8");
    assert.match(text, /index\.md/);
    assert.match(text, /notes\/index\.md/);
    assert.match(text, /topics\/index\.md/);
    assert.match(text, /credential/i);
    assert.match(text, /\.okf-vault\/tmp/);
  });
});

describe("Cross-artifact integration", () => {
  it("deck envelope, note, manifest, proposal, and report share stable source and claim identifiers", () => {
    const sourceKey = "drive:file-abc123";
    const claimId = "claim-001";
    const notePath = "notes/strategy-deck.md";

    const manifest = {
      schema_version: "okf-vault-manifest/1.0.0",
      note_contract_version: "okf-note-contract/1.0.0",
      sources: [
        {
          source_key: sourceKey,
          kind: "google_drive",
          origin: "drive:file-abc123",
          content_sha256: VALID_SHA,
          contract_version: "okf-note-contract/1.0.0",
          note_path: notePath,
          status: "committed",
          commit: "deadbeef",
          processed_at: VALID_TS,
        },
      ],
    };

    const proposal = {
      schema_version: "okf-vault-proposal/1.0.0",
      proposal_id: "prop-deck-001",
      type: "duplicate",
      affected_paths: [notePath, "notes/strategy-article.md"],
      claim_ids: [claimId],
      rationale: "Same revenue figure cited differently",
      confidence: "high",
      disposition: "pending",
    };

    const report = {
      schema_version: "okf-vault-validation-report/1.0.0",
      contract_version: "okf-note-contract/1.0.0",
      status: "pass",
      summary: `Validated ${notePath} for ${sourceKey}.`,
      issues: [],
    };

    const envelope = {
      contract_version: "okf-source-envelope/1.0.0",
      source_key: sourceKey,
      kind: "google_drive",
      content_type: "application/vnd.google-apps.presentation",
      origin: "drive:file-abc123",
      canonical_uri: "https://drive.google.com/file/d/file-abc123/view",
      title: "Strategy Deck",
      modified_at: VALID_TS,
      content_sha256: VALID_SHA,
      normalized_text: "slide content",
      anchors: [
        {
          id: "slide-001",
          kind: "slide",
          label: "Slide 1",
          text: "Revenue grew 12%",
          slide_number: 1,
        },
      ],
      slides: [
        {
          number: 1,
          title: "Overview",
          text: "Revenue grew 12%",
          speaker_notes: "",
          image_available: true,
        },
      ],
      deck_complete: true,
    };

    const { validate: validateManifest } = createValidator("manifest.schema.json");
    const { validate: validateProposal } = createValidator("proposal.schema.json");
    const { validate: validateReport } = createValidator("validation-report.schema.json");

    assert.ok(validateManifest(manifest));
    assert.ok(validateProposal(proposal));
    assert.ok(validateReport(report));
    assert.equal(envelope.source_key, manifest.sources[0].source_key);
    assert.equal(manifest.sources[0].note_path, proposal.affected_paths[0]);
    assert.ok(proposal.claim_ids.includes(claimId));
  });

  it("vault-relative paths accept valid notes paths and reject traversal", () => {
    const { validate } = createValidator("manifest.schema.json");
    const committed = (notePath) => ({
      schema_version: "okf-vault-manifest/1.0.0",
      note_contract_version: "okf-note-contract/1.0.0",
      sources: [
        {
          source_key: "local:/tmp/x.md",
          kind: "local",
          origin: "/tmp/x.md",
          content_sha256: VALID_SHA,
          contract_version: "okf-note-contract/1.0.0",
          note_path: notePath,
          status: "committed",
          commit: "abc1234",
          processed_at: VALID_TS,
        },
      ],
    });
    assert.ok(validate(committed("notes/example.md")));
    assert.ok(!validate(committed("/absolute/path.md")));
    assert.ok(!validate(committed("notes/../secret.md")));
  });
});
