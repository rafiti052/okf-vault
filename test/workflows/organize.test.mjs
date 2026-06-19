import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  documentsIncrementalOrganizeScope,
  documentsOrganizeApplicationPreservesNotePaths,
  documentsOrganizeDispositionTemplate,
  documentsOrganizeInitialPendingGate,
  documentsOrganizeJournalBlock,
  documentsOrganizePathMoveRejection,
  documentsOrganizeProposalOnlyBoundary,
  skillRoot,
} from "./workflow-contract.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..", "..");
const organizeDoc = join(skillRoot(root), "references", "organize.md");
const skillDoc = join(skillRoot(root), "SKILL.md");
const progressDoc = join(skillRoot(root), "references", "progress-events.md");

describe("organize workflow contract", () => {
  it("documents initial pending-source gate and proposal-only boundary", () => {
    const organize = readFileSync(organizeDoc, "utf8");
    const skill = readFileSync(skillDoc, "utf8");

    assert.equal(documentsOrganizeInitialPendingGate(organize), true);
    assert.equal(documentsOrganizeProposalOnlyBoundary(organize), true);
    assert.equal(documentsOrganizeJournalBlock(organize), true);
    assert.match(skill, /organize\.md/);
    assert.match(skill, /Never.*auto-apply/is);
  });

  it("documents incremental scoping, disposition template, and path preservation", () => {
    const organize = readFileSync(organizeDoc, "utf8");

    assert.equal(documentsIncrementalOrganizeScope(organize), true);
    assert.equal(documentsOrganizeDispositionTemplate(organize), true);
    assert.equal(documentsOrganizeApplicationPreservesNotePaths(organize), true);
    assert.equal(documentsOrganizePathMoveRejection(organize), true);
  });

  it("documents organize_proposals_ready emission rules", () => {
    const progress = readFileSync(progressDoc, "utf8");
    assert.match(progress, /organize_proposals_ready/);
    assert.match(progress, /validate-proposals/);
    assert.match(progress, /proposal_count/);
    assert.match(progress, /Do \*\*not\*\* emit `organize_proposals_ready`/);
  });
});
