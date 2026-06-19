import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../../dist/cli.js";
import {
  DOSSIER_BOUNDS,
  dossierContainsCredentialKeys,
  generateVaultDossiers,
} from "../../dist/vault/dossier.js";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import {
  initializeVault,
  loadManifest,
  manifestRevision,
  saveManifest,
} from "../../dist/vault/manifest.js";
import { commitIngestFixture } from "../../dist/vault/ingestion.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const bin = join(root, "dist", "main.js");
const fixturesDir = join(root, "test", "fixtures");
const goldDir = join(fixturesDir, "notes", "gold");
const envelopesDir = join(fixturesDir, "envelopes");
const proposalsDir = join(fixturesDir, "proposals");

const ARTICLE_ENVELOPE = join(envelopesDir, "article", "accepted-01.json");
const ARTICLE_NOTE = join(goldDir, "article", "accepted-01.md");
const ARTICLE_STAGED = "notes/gold-article-01.md";

const DECK_ENVELOPE = join(envelopesDir, "deck", "accepted-01.json");
const DECK_NOTE = join(goldDir, "deck", "accepted-01.md");
const DECK_STAGED = "notes/gold-deck-01.md";

const PANEL_ENVELOPE = join(envelopesDir, "panel", "accepted-01.json");
const PANEL_NOTE = join(goldDir, "panel", "accepted-01.md");
const PANEL_STAGED = "notes/gold-panel-01.md";

const VIDEO_ENVELOPE = join(envelopesDir, "video", "accepted-01.json");
const VIDEO_NOTE = join(goldDir, "video", "accepted-01.md");
const VIDEO_STAGED = "notes/gold-video-01.md";

function prepareIngestedVault(): string {
  const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-ingest-"));
  initializeVault(vaultRoot);

  const fixtures = [
    {
      runId: "run-article",
      envelopePath: ARTICLE_ENVELOPE,
      goldNotePath: ARTICLE_NOTE,
      stagedNotePath: ARTICLE_STAGED,
    },
    {
      runId: "run-deck",
      envelopePath: DECK_ENVELOPE,
      goldNotePath: DECK_NOTE,
      stagedNotePath: DECK_STAGED,
    },
    {
      runId: "run-panel",
      envelopePath: PANEL_ENVELOPE,
      goldNotePath: PANEL_NOTE,
      stagedNotePath: PANEL_STAGED,
    },
    {
      runId: "run-video",
      envelopePath: VIDEO_ENVELOPE,
      goldNotePath: VIDEO_NOTE,
      stagedNotePath: VIDEO_STAGED,
    },
  ];

  let revision = manifestRevision(loadManifest(vaultRoot));
  for (const fixture of fixtures) {
    commitIngestFixture({
      vaultRoot,
      ...fixture,
      expectedRevision: revision,
    });
    revision = manifestRevision(loadManifest(vaultRoot));
  }

  mkdirSync(join(vaultRoot, "topics"), { recursive: true });
  writeFileSync(
    join(vaultRoot, "topics/strategy.md"),
    `---
type: Topic Map
title: Strategy
description: Strategy topic map fixture.
contract_version: okf-note-contract/1.0.0
---

# Summary

Strategy topic grouping.

# Key Claims

- Strategy themes.

# Citations

- Strategy
`,
    "utf8",
  );

  return vaultRoot;
}

describe("dossier CLI integration", () => {
  it("returns one dossier per committed note with resolvable paths and no credential-like keys", () => {
    const vaultRoot = prepareIngestedVault();
    const committedPaths = loadManifest(vaultRoot)
      .sources.filter((record) => record.status === "committed")
      .map((record) => record.note_path as string)
      .sort();

    const outcome = spawnSync(process.execPath, [bin, "dossier", vaultRoot], { encoding: "utf8" });
    assert.equal(outcome.status, ExitCode.SUCCESS);

    const payload = JSON.parse(outcome.stdout) as {
      status: string;
      data: { dossiers: Array<{ path: string }>; count: number };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.count, committedPaths.length);
    assert.deepEqual(payload.data.dossiers.map((entry) => entry.path).sort(), committedPaths);

    for (const notePath of committedPaths) {
      assert.ok(existsSync(join(vaultRoot, notePath)));
    }

    const credentialHits = dossierContainsCredentialKeys(payload.data);
    assert.deepEqual(credentialHits, []);

    const serialized = JSON.stringify(payload.data);
    assert.doesNotMatch(serialized, /normalized_text|access_token|refresh_token|api_key/);
  });
});

describe("validate-proposals CLI integration", () => {
  it("accepts a fixture set covering all four proposal types with exit 0", () => {
    const vaultRoot = prepareIngestedVault();
    const proposalsPath = join(proposalsDir, "valid-all-types.json");

    const outcome = spawnSync(
      process.execPath,
      [bin, "validate-proposals", vaultRoot, proposalsPath],
      {
        encoding: "utf8",
      },
    );
    assert.equal(outcome.status, ExitCode.SUCCESS);

    const payload = JSON.parse(outcome.stdout) as {
      status: string;
      data: { status: string; valid_proposal_ids: string[]; invalid_proposal_ids: string[] };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.status, "pass");
    assert.equal(payload.data.invalid_proposal_ids.length, 0);
    assert.equal(payload.data.valid_proposal_ids.length, 4);
  });

  it("exits 3 for mixed batches and identifies only invalid proposal ids", () => {
    const vaultRoot = prepareIngestedVault();
    const proposalsPath = join(proposalsDir, "mixed-valid-invalid.json");

    const outcome = spawnSync(
      process.execPath,
      [bin, "validate-proposals", vaultRoot, proposalsPath],
      {
        encoding: "utf8",
      },
    );
    assert.equal(outcome.status, ExitCode.VALIDATION);

    const payload = JSON.parse(outcome.stdout) as {
      status: string;
      data: { status: string; valid_proposal_ids: string[]; invalid_proposal_ids: string[] };
    };
    assert.equal(payload.status, "ok");
    assert.equal(payload.data.status, "fail");
    assert.deepEqual(payload.data.valid_proposal_ids, ["prop-valid-link"]);
    assert.deepEqual(
      payload.data.invalid_proposal_ids.sort(),
      ["prop-missing-claims", "prop-outside-path"].sort(),
    );
  });
});

describe("50-note dossier corpus bounds", () => {
  it("keeps every dossier within documented serialized bounds", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-50-"));
    initializeVault(vaultRoot);

    const notePaths: string[] = [];
    for (let index = 1; index <= 50; index += 1) {
      const notePath = `notes/corpus-${String(index).padStart(2, "0")}.md`;
      notePaths.push(notePath);
      writeFileSync(
        join(vaultRoot, notePath),
        `---
type: Article Note
title: Corpus Note ${index}
description: Fifty-note dossier bound fixture ${index}.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/corpus-${index}.md
  kind: local
  origin: /tmp/corpus-${index}.md
  content_sha256: ${"a".repeat(64)}
  acquired_at: 2026-06-19T12:00:00.000Z
tags:
  - topic-${index % 5}
claims:
  - id: claim-001
    text: Corpus claim ${index}
    anchors:
      - anchor-001
---

# Summary

Summary for corpus note ${index}.

# Key Claims

- Corpus claim ${index} (claim-001).

# Citations

- Corpus ${index}

# Evidence

> Evidence ${index}.
`,
        "utf8",
      );
    }

    saveManifest(vaultRoot, {
      schema_version: "okf-vault-manifest/1.0.0",
      note_contract_version: NOTE_CONTRACT_VERSION,
      sources: notePaths.map((notePath, index) => ({
        source_key: `local:/tmp/corpus-${index + 1}.md`,
        kind: "local" as const,
        origin: `/tmp/corpus-${index + 1}.md`,
        content_sha256: "a".repeat(64),
        contract_version: NOTE_CONTRACT_VERSION,
        note_path: notePath,
        status: "committed" as const,
        commit: "abc1234",
        processed_at: "2026-06-19T12:00:00.000Z",
      })),
    });

    const result = generateVaultDossiers(vaultRoot);
    assert.equal(result.count, 50);
    for (const dossier of result.dossiers) {
      assert.ok(JSON.stringify(dossier).length <= DOSSIER_BOUNDS.maxSerializedBytes);
    }
  });
});
