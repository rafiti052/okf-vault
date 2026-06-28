import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildNoteDossier,
  DOSSIER_BOUNDS,
  DOSSIER_SCHEMA_VERSION,
  DOSSIER_SET_SCHEMA_VERSION,
  generateVaultDossiers,
} from "../../dist/vault/dossier.js";
import { NOTE_CONTRACT_VERSION } from "../../dist/vault/constants.js";
import { buildVaultLinkGraph } from "../../dist/vault/graph.js";
import { initializeVault, saveManifest, type SourceRecord } from "../../dist/vault/manifest.js";
import { parseNoteContent } from "../../dist/vault/validation.js";

const VALID_SHA = "a".repeat(64);
const VALID_TS = "2026-06-19T12:00:00.000Z";

function committedRecord(notePath: string, sourceKey: string): SourceRecord {
  return {
    source_key: sourceKey,
    kind: "local",
    origin: `/fixtures/${notePath}`,
    content_sha256: VALID_SHA,
    contract_version: NOTE_CONTRACT_VERSION,
    note_path: notePath,
    status: "committed",
    commit: "abc1234",
    processed_at: VALID_TS,
  };
}

function writeNote(vaultRoot: string, relativePath: string, content: string): void {
  const absolutePath = join(vaultRoot, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, "utf8");
}

function tenClaimNote(): string {
  const claimsYaml = Array.from({ length: 10 }, (_, index) => {
    const id = `claim-${String(index + 1).padStart(3, "0")}`;
    return `  - id: ${id}
    text: ${"Long claim statement ".repeat(12)}(${id})`;
  }).join("\n");

  const keyClaims = Array.from({ length: 10 }, (_, index) => {
    const id = `claim-${String(index + 1).padStart(3, "0")}`;
    return `- Material finding ${index + 1} (${id}).`;
  }).join("\n");

  return `---
type: Article Note
title: Ten Claim Note
description: Dossier bounds fixture with ten claims.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/ten-claims.md
  kind: local
  origin: /tmp/ten-claims.md
  content_sha256: ${VALID_SHA}
  acquired_at: ${VALID_TS}
tags:
  - strategy
  - revenue
claims:
${claimsYaml}
---

# Summary

${"Summary paragraph with repeated detail. ".repeat(40)}

# Key Claims

${keyClaims}

# Citations

- Ten Claim Note

# Evidence

> Evidence excerpt.
`;
}

describe("dossier bounds", () => {
  it("truncates a ten-claim note while preserving every claim id", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-bounds-"));
    initializeVault(vaultRoot);
    writeNote(vaultRoot, "notes/ten-claims.md", tenClaimNote());

    const parsed = parseNoteContent(
      "notes/ten-claims.md",
      readFileSync(join(vaultRoot, "notes/ten-claims.md"), "utf8"),
    );
    assert.ok(!Array.isArray(parsed));

    const graph = buildVaultLinkGraph(vaultRoot);
    const dossier = buildNoteDossier(parsed, graph);
    assert.ok(dossier !== null);
    assert.equal(dossier.claim_ids.length, 10);
    assert.equal(dossier.claims.length, DOSSIER_BOUNDS.maxClaimsWithText);
    assert.equal(dossier.claims_truncated, true);

    for (const claim of dossier.claims) {
      assert.ok(claim.text.length <= DOSSIER_BOUNDS.maxClaimTextChars);
    }

    for (const claimId of dossier.claim_ids) {
      assert.match(claimId, /^claim-\d{3}$/);
    }

    assert.ok(dossier.summary.length <= DOSSIER_BOUNDS.maxSummaryChars);
    assert.ok(JSON.stringify(dossier).length <= DOSSIER_BOUNDS.maxSerializedBytes);
  });
});

describe("dossier ordering", () => {
  it("serializes dossiers in stable path order regardless of filesystem iteration", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-order-"));
    initializeVault(vaultRoot);

    const noteTemplate = (slug: string, title: string) => `---
type: Article Note
title: ${title}
description: Ordering fixture ${slug}.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/${slug}.md
  kind: local
  origin: /tmp/${slug}.md
  content_sha256: ${VALID_SHA}
  acquired_at: ${VALID_TS}
claims:
  - id: claim-001
    text: Claim for ${slug}
    anchors:
      - anchor-001
---

# Summary

Summary for ${slug}.

# Key Claims

- Claim (${slug}) (claim-001).

# Citations

- ${title}

# Evidence

> Evidence.
`;

    const paths = ["notes/z-last.md", "notes/a-first.md", "notes/m-middle.md"];
    for (const path of paths) {
      const slug = path.replace("notes/", "").replace(".md", "");
      writeNote(vaultRoot, path, noteTemplate(slug, slug));
    }

    saveManifest(vaultRoot, {
      schema_version: "okf-vault-manifest/1.0.0",
      note_contract_version: NOTE_CONTRACT_VERSION,
      sources: paths.map((notePath, index) =>
        committedRecord(notePath, `local:/tmp/source-${index}.md`),
      ),
    });

    const first = generateVaultDossiers(vaultRoot);
    const second = generateVaultDossiers(vaultRoot);

    assert.deepEqual(
      first.dossiers.map((entry) => entry.path),
      ["notes/a-first.md", "notes/m-middle.md", "notes/z-last.md"],
    );
    assert.deepEqual(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.schema_version, DOSSIER_SET_SCHEMA_VERSION);
    assert.equal(first.dossiers[0]?.schema_version, DOSSIER_SCHEMA_VERSION);
  });
});

describe("empty dossier set", () => {
  it("returns a structured empty result for zero committed notes", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-empty-"));
    initializeVault(vaultRoot);

    const result = generateVaultDossiers(vaultRoot);
    assert.equal(result.count, 0);
    assert.deepEqual(result.dossiers, []);
    assert.equal(result.contract_version, NOTE_CONTRACT_VERSION);
  });
});

describe("dossier field extraction", () => {
  it("derives summary, source identity, links, and topic hints from validated sections only", () => {
    const vaultRoot = mkdtempSync(join(tmpdir(), "okf-dossier-fields-"));
    initializeVault(vaultRoot);

    writeNote(
      vaultRoot,
      "notes/source-a.md",
      `---
type: Article Note
title: Source A
description: Link source.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/a.md
  kind: local
  origin: /tmp/a.md
  content_sha256: ${VALID_SHA}
  acquired_at: ${VALID_TS}
claims:
  - id: claim-001
    text: Source claim
    anchors:
      - anchor-001
---

# Summary

Source summary.

# Key Claims

- Source claim (claim-001).

# Citations

- A

# Evidence

> Evidence.
`,
    );

    writeNote(
      vaultRoot,
      "notes/source-b.md",
      `---
type: Article Note
title: Source B
description: Link target.
contract_version: okf-note-contract/1.0.0
source:
  source_key: local:/tmp/b.md
  kind: local
  origin: /tmp/b.md
  content_sha256: ${VALID_SHA}
  acquired_at: ${VALID_TS}
tags:
  - leadership
claims:
  - id: claim-001
    text: Target claim
    anchors:
      - anchor-001
---

# Summary

Target summary.

# Key Claims

- Target claim (claim-001).

# Citations

- B

# Evidence

> Evidence.

See also [[notes/source-a.md]].
`,
    );

    saveManifest(vaultRoot, {
      schema_version: "okf-vault-manifest/1.0.0",
      note_contract_version: NOTE_CONTRACT_VERSION,
      sources: [
        committedRecord("notes/source-a.md", "local:/tmp/a.md"),
        committedRecord("notes/source-b.md", "local:/tmp/b.md"),
      ],
    });

    const result = generateVaultDossiers(vaultRoot);
    const target = result.dossiers.find((entry) => entry.path === "notes/source-b.md");
    assert.ok(target !== undefined);
    assert.equal(target.source.source_key, "local:/tmp/b.md");
    assert.equal(target.source.kind, "local");
    assert.deepEqual(target.topic_hints, ["leadership"]);
    assert.ok(target.existing_links.includes("notes/source-a.md"));
    assert.match(JSON.stringify(target), /Target summary/);
    assert.doesNotMatch(JSON.stringify(target), /normalized_text|access_token|api_key/);
  });
});
