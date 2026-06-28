import { join, resolve } from "node:path";

/**
 * Managed artifact manifest for OKV install, legacy sweep, and uninstall consumers.
 *
 * @typedef {"symlink" | "file-copy" | "global-bin"} ManagedArtifactKind
 *
 * @typedef {object} ManagedArtifact
 * @property {ManagedArtifactKind} kind Artifact management strategy.
 * @property {string} label Human-readable artifact label for reports.
 * @property {string} [path] Absolute repo-local artifact path, resolved from projectRoot.
 * @property {string} [name] Global binary name. Global-bin entries are name-only.
 * @property {string} [target] Absolute target path for symlink artifacts.
 * @property {string} [template] Absolute source template path for file-copy artifacts.
 * @property {boolean} [legacy] True for pre-rebrand artifacts swept during upgrade.
 * @property {boolean} [tombstone] True for the non-forwarding legacy guidance binary.
 */

export const OKV_COMMANDS = [
  "okv-ingest",
  "okv-init",
  "okv-organize",
  "okv-validate",
  "okv-visualize",
  "okv-bootstrap",
  "okv-ingest-check",
  "okv-ask",
];

/** Commands that existed under the vault-* prefix before the okv-* rebrand. */
export const REBRANDED_OKV_COMMANDS = OKV_COMMANDS.filter((c) => c !== "okv-ask");

export const LEGACY_VAULT_COMMANDS = REBRANDED_OKV_COMMANDS.map((command) =>
  command.replace(/^okv-/, "vault-"),
);

const CANONICAL_SKILL_RELATIVE = join(".agents", "skills", "okf-vault");
const LEGACY_CANONICAL_SKILL_RELATIVE = join(".agents", "skills", "okf-knowledge-vault");
const OKV_RULE_RELATIVE = join(".cursor", "rules", "okv.mdc");
const LEGACY_RULE_RELATIVE = join(".cursor", "rules", "okf-vault.mdc");

/**
 * @param {string} root
 * @param {string[]} parts
 * @returns {string}
 */
function localPath(root, ...parts) {
  return join(resolve(root), ...parts);
}

/**
 * @param {string} root
 * @param {string} command
 * @returns {string}
 */
function commandTarget(root, command) {
  return localPath(root, CANONICAL_SKILL_RELATIVE, "commands", `${command}.md`);
}

/**
 * @param {string} root
 * @param {string} command
 * @returns {string}
 */
function legacyCommandTarget(root, command) {
  return localPath(root, LEGACY_CANONICAL_SKILL_RELATIVE, "commands", `${command}.md`);
}

/**
 * Enumerates current OKV-managed artifacts without touching the filesystem.
 *
 * @param {string} projectRoot
 * @returns {ManagedArtifact[]}
 */
export function listManagedArtifacts(projectRoot) {
  const root = resolve(projectRoot);
  const canonicalSkill = localPath(root, CANONICAL_SKILL_RELATIVE);
  const artifacts = [
    {
      kind: "symlink",
      path: localPath(root, ".cursor", "skills", "okf-vault"),
      target: canonicalSkill,
      label: "Cursor umbrella skill",
    },
    {
      kind: "symlink",
      path: localPath(root, ".claude", "skills", "okf-vault"),
      target: canonicalSkill,
      label: "Claude umbrella skill",
    },
  ];

  for (const command of OKV_COMMANDS) {
    const target = commandTarget(root, command);
    artifacts.push(
      {
        kind: "symlink",
        path: localPath(root, ".cursor", "skills", command, "SKILL.md"),
        target,
        label: `Cursor /${command}`,
      },
      {
        kind: "symlink",
        path: localPath(root, ".claude", "commands", `${command}.md`),
        target,
        label: `Claude /${command}`,
      },
    );
  }

  artifacts.push(
    {
      kind: "file-copy",
      path: localPath(root, OKV_RULE_RELATIVE),
      template: localPath(root, CANONICAL_SKILL_RELATIVE, "templates", "okv.mdc"),
      label: "Cursor curator rule",
    },
    {
      kind: "global-bin",
      name: "okv",
      label: "Primary OKV global binary",
    },
    {
      kind: "global-bin",
      name: "okf-vault",
      label: "Legacy guidance tombstone binary",
      tombstone: true,
    },
  );

  return artifacts;
}

/**
 * Enumerates pre-rebrand artifacts swept during upgrade/uninstall without touching the filesystem.
 *
 * @param {string} projectRoot
 * @returns {ManagedArtifact[]}
 */
export function listLegacyArtifacts(projectRoot) {
  const root = resolve(projectRoot);
  const legacySkill = localPath(root, LEGACY_CANONICAL_SKILL_RELATIVE);
  const artifacts = [
    {
      kind: "symlink",
      path: legacySkill,
      target: legacySkill,
      label: "Legacy canonical skill path",
      legacy: true,
    },
    {
      kind: "symlink",
      path: localPath(root, ".cursor", "skills", "okf-knowledge-vault"),
      target: legacySkill,
      label: "Legacy Cursor umbrella skill",
      legacy: true,
    },
    {
      kind: "symlink",
      path: localPath(root, ".claude", "skills", "okf-knowledge-vault"),
      target: legacySkill,
      label: "Legacy Claude umbrella skill",
      legacy: true,
    },
  ];

  for (const command of LEGACY_VAULT_COMMANDS) {
    const target = legacyCommandTarget(root, command);
    artifacts.push(
      {
        kind: "symlink",
        path: localPath(root, ".cursor", "skills", command, "SKILL.md"),
        target,
        label: `Legacy Cursor /${command}`,
        legacy: true,
      },
      {
        kind: "symlink",
        path: localPath(root, ".claude", "commands", `${command}.md`),
        target,
        label: `Legacy Claude /${command}`,
        legacy: true,
      },
    );
  }

  artifacts.push(
    {
      kind: "file-copy",
      path: localPath(root, LEGACY_RULE_RELATIVE),
      template: localPath(root, LEGACY_CANONICAL_SKILL_RELATIVE, "templates", "cursor-rule.mdc"),
      label: "Legacy Cursor curator rule",
      legacy: true,
    },
    {
      kind: "global-bin",
      name: "okf-vault",
      label: "Legacy full CLI global binary",
      legacy: true,
    },
  );

  return artifacts;
}
