/** Supported persisted contract versions. */
export const MANIFEST_SCHEMA_VERSION = "okf-vault-manifest/1.0.0" as const;
export const NOTE_CONTRACT_VERSION = "okf-note-contract/1.0.0" as const;
export const SOURCE_SPAN_CONTRACT_VERSION = "okf-source-spans/1.0.0" as const;

export const MANIFEST_RELATIVE_PATH = ".okf-vault/manifest.json";
export const LOCK_RELATIVE_PATH = ".okf-vault/lock";
export const JOURNAL_RELATIVE_PATH = ".okf-vault/journal.json";
export const REVIEWS_DIR = ".okf-vault/reviews";
export const TMP_DIR = ".okf-vault/tmp";
export const REVIEWS_GITKEEP = ".okf-vault/reviews/.gitkeep";

export const ROOT_INDEX_PATH = "index.md";
export const LOG_PATH = "log.md";
export const NOTES_INDEX_PATH = "notes/index.md";
export const TOPICS_INDEX_PATH = "topics/index.md";
export const REFERENCES_DIR = "references";
export const SOURCE_SPANS_DIR = `${REFERENCES_DIR}/sources`;
export const SOURCE_SPANS_PATHSPEC = `${SOURCE_SPANS_DIR}/`;
export const GITIGNORE_PATH = ".gitignore";

/** Pathspecs checked for clean index and working tree before transactions. */
export const MANAGED_CLEAN_PATHSPECS = [
  ROOT_INDEX_PATH,
  LOG_PATH,
  NOTES_INDEX_PATH,
  TOPICS_INDEX_PATH,
  MANIFEST_RELATIVE_PATH,
  "notes/",
  "topics/",
  SOURCE_SPANS_PATHSPEC,
] as const;

export const ROOT_INDEX_CONTENT = `# OKF Knowledge Vault

## Indexes

- [Notes](notes/index.md)
- [Topics](topics/index.md)
`;

export const NOTES_INDEX_CONTENT = `# Notes

<!-- Managed notes index — updated by the okf-vault helper -->
`;

export const TOPICS_INDEX_CONTENT = `# Topics

<!-- Managed topics index — updated by the okf-vault helper -->
`;

export const LOG_CONTENT = `# Change Log

`;

export const GITIGNORE_ENTRY = ".okf-vault/tmp/";

/** Paths staged during initialization baseline commit. */
export const INIT_STAGED_PATHS = [
  ROOT_INDEX_PATH,
  LOG_PATH,
  NOTES_INDEX_PATH,
  TOPICS_INDEX_PATH,
  GITIGNORE_PATH,
  MANIFEST_RELATIVE_PATH,
  REVIEWS_GITKEEP,
] as const;

export const MANAGED_INIT_FILES: Readonly<Record<string, string>> = {
  [ROOT_INDEX_PATH]: ROOT_INDEX_CONTENT,
  [LOG_PATH]: LOG_CONTENT,
  [NOTES_INDEX_PATH]: NOTES_INDEX_CONTENT,
  [TOPICS_INDEX_PATH]: TOPICS_INDEX_CONTENT,
};
