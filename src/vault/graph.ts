import * as fs from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { type DispatchOutcome, ExitCode, failure, success } from "../cli.js";
import {
  MANIFEST_RELATIVE_PATH,
  NOTE_CONTRACT_VERSION,
  NOTES_INDEX_PATH,
  ROOT_INDEX_PATH,
  TOPICS_INDEX_PATH,
} from "./constants.js";
import { loadManifest } from "./manifest.js";
import { buildValidationReport, isVaultRelativePath, type ValidationIssue } from "./validation.js";

export const GRAPH_SCAN_PATHS = [ROOT_INDEX_PATH, NOTES_INDEX_PATH, TOPICS_INDEX_PATH] as const;

const MANAGED_NOTE_DIRS = ["notes", "topics"] as const;

const WIKILINK_PATTERN = /\[\[(?:[^\]|]+\|)?([^\]|]+)\]\]/gu;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)]+)\)/gu;

function issue(code: string, message: string, path?: string): ValidationIssue {
  const entry: ValidationIssue = { code, message };
  if (path !== undefined) {
    entry.path = path;
  }
  return entry;
}

function stripAnchor(rawTarget: string): string {
  const hashIndex = rawTarget.indexOf("#");
  return hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
}

function normalizeVaultPath(pathValue: string): string {
  const normalized = normalize(pathValue.split("\\").join("/"));
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

function withMarkdownExtension(relativePath: string): string {
  if (extname(relativePath).length === 0) {
    return `${relativePath}.md`;
  }
  return relativePath;
}

function isManagedGraphTarget(relativePath: string): boolean {
  return (
    relativePath === ROOT_INDEX_PATH ||
    relativePath === NOTES_INDEX_PATH ||
    relativePath === TOPICS_INDEX_PATH ||
    relativePath.startsWith("notes/") ||
    relativePath.startsWith("topics/")
  );
}

export function resolveLinkTarget(sourcePath: string, rawTarget: string): string | null {
  const trimmed = stripAnchor(rawTarget.trim());
  if (trimmed.length === 0 || /^https?:\/\//iu.test(trimmed)) {
    return null;
  }

  if (trimmed.startsWith("/") || trimmed.match(/^[a-zA-Z]:[/\\]/u) !== null) {
    return null;
  }

  let vaultRelative: string;
  const normalizedTarget = normalizeVaultPath(trimmed);
  if (
    normalizedTarget.startsWith("notes/") ||
    normalizedTarget.startsWith("topics/") ||
    normalizedTarget === ROOT_INDEX_PATH
  ) {
    vaultRelative = withMarkdownExtension(normalizedTarget);
  } else {
    const sourceDir = dirname(sourcePath);
    vaultRelative = withMarkdownExtension(normalizeVaultPath(join(sourceDir, trimmed)));
  }

  if (!isVaultRelativePath(vaultRelative) || !isManagedGraphTarget(vaultRelative)) {
    return null;
  }

  return vaultRelative;
}

export function extractLinkTargets(content: string): string[] {
  const targets: string[] = [];

  for (const match of content.matchAll(WIKILINK_PATTERN)) {
    const target = match[1];
    if (target !== undefined && target.trim().length > 0) {
      targets.push(target.trim());
    }
  }

  for (const match of content.matchAll(MARKDOWN_LINK_PATTERN)) {
    const target = match[1];
    if (target !== undefined && target.trim().length > 0) {
      targets.push(target.trim());
    }
  }

  return targets;
}

function listManagedMarkdownFiles(vaultRoot: string): string[] {
  const files: string[] = [];

  for (const scanPath of GRAPH_SCAN_PATHS) {
    files.push(scanPath);
  }

  for (const dir of MANAGED_NOTE_DIRS) {
    const absoluteDir = join(vaultRoot, dir);
    if (!fs.existsSync(absoluteDir)) {
      continue;
    }

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name === "index.md") {
        continue;
      }
      files.push(`${dir}/${entry.name}`);
    }
  }

  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

export interface LinkEdge {
  source: string;
  target: string;
}

export interface VaultLinkGraph {
  nodes: string[];
  edges: LinkEdge[];
  brokenLinks: ValidationIssue[];
}

export function buildVaultLinkGraph(vaultRoot: string): VaultLinkGraph {
  const root = resolve(vaultRoot);
  const nodes = listManagedMarkdownFiles(root);
  const nodeSet = new Set(nodes);
  const edges: LinkEdge[] = [];
  const brokenLinks: ValidationIssue[] = [];

  for (const sourcePath of nodes) {
    const absolutePath = join(root, sourcePath);
    if (!fs.existsSync(absolutePath)) {
      brokenLinks.push(
        issue(
          "BROKEN_LINK_TARGET",
          `Managed graph node is missing on disk: ${sourcePath}`,
          sourcePath,
        ),
      );
      continue;
    }

    const content = fs.readFileSync(absolutePath, "utf8");
    for (const rawTarget of extractLinkTargets(content)) {
      const resolved = resolveLinkTarget(sourcePath, rawTarget);
      if (resolved === null) {
        continue;
      }

      const absoluteTarget = join(root, resolved);
      if (!fs.existsSync(absoluteTarget)) {
        brokenLinks.push(
          issue(
            "BROKEN_LINK_TARGET",
            `Link from '${sourcePath}' targets missing note '${resolved}' (${resolved}).`,
            sourcePath,
          ),
        );
        continue;
      }

      edges.push({ source: sourcePath, target: resolved });
      if (!nodeSet.has(resolved)) {
        nodeSet.add(resolved);
        nodes.push(resolved);
      }
    }
  }

  return {
    nodes: [...new Set(nodes)].sort((left, right) => left.localeCompare(right)),
    edges,
    brokenLinks,
  };
}

function adjacencyList(edges: LinkEdge[]): Map<string, Set<string>> {
  const adjacency = new Map<string, Set<string>>();
  for (const edge of edges) {
    const existing = adjacency.get(edge.source);
    if (existing === undefined) {
      adjacency.set(edge.source, new Set([edge.target]));
    } else {
      existing.add(edge.target);
    }
  }
  return adjacency;
}

function reachableWithinHops(
  start: string,
  adjacency: Map<string, Set<string>>,
  maxHops: number,
): Set<string> {
  const visited = new Set<string>([start]);
  let frontier = new Set<string>([start]);

  for (let depth = 0; depth < maxHops; depth += 1) {
    const nextFrontier = new Set<string>();
    for (const node of frontier) {
      const neighbors = adjacency.get(node);
      if (neighbors === undefined) {
        continue;
      }
      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) {
      break;
    }
  }

  return visited;
}

function reachableFromRoot(adjacency: Map<string, Set<string>>): Set<string> {
  const visited = new Set<string>();
  const queue: string[] = [ROOT_INDEX_PATH];
  visited.add(ROOT_INDEX_PATH);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      break;
    }
    const neighbors = adjacency.get(current);
    if (neighbors === undefined) {
      continue;
    }
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  return visited;
}

function committedNotePaths(vaultRoot: string): string[] {
  const manifest = loadManifest(vaultRoot);
  return manifest.sources
    .filter((record) => record.status === "committed" && record.note_path !== undefined)
    .map((record) => record.note_path as string)
    .sort((left, right) => left.localeCompare(right));
}

export function checkVaultInitialization(vaultRoot: string): ValidationIssue[] {
  const root = resolve(vaultRoot);
  const issues: ValidationIssue[] = [];

  if (!fs.existsSync(root)) {
    issues.push(
      issue("VAULT_NOT_INITIALIZED", `Vault root does not exist: ${root}`, MANIFEST_RELATIVE_PATH),
    );
    return issues;
  }

  const requiredPaths = [
    MANIFEST_RELATIVE_PATH,
    ROOT_INDEX_PATH,
    NOTES_INDEX_PATH,
    TOPICS_INDEX_PATH,
  ];
  for (const relativePath of requiredPaths) {
    if (!fs.existsSync(join(root, relativePath))) {
      issues.push(
        issue(
          "VAULT_NOT_INITIALIZED",
          `Required vault file is missing: ${relativePath}`,
          relativePath,
        ),
      );
    }
  }

  return issues;
}

export interface GraphValidationResult {
  report: ReturnType<typeof buildValidationReport>;
  graph: VaultLinkGraph;
  committed_note_paths: string[];
}

export function validateVaultGraph(vaultRoot: string): GraphValidationResult {
  const initIssues = checkVaultInitialization(vaultRoot);
  if (initIssues.length > 0) {
    const report = buildValidationReport(NOTE_CONTRACT_VERSION, initIssues);
    return {
      report,
      graph: { nodes: [], edges: [], brokenLinks: [] },
      committed_note_paths: [],
    };
  }

  const manifest = loadManifest(vaultRoot);
  const graph = buildVaultLinkGraph(vaultRoot);
  const issues: ValidationIssue[] = [...graph.brokenLinks];
  const adjacency = adjacencyList(graph.edges);
  const allReachable = reachableFromRoot(adjacency);
  const twoHopReachable = reachableWithinHops(ROOT_INDEX_PATH, adjacency, 2);
  const requiredNotes = committedNotePaths(vaultRoot);

  for (const notePath of requiredNotes) {
    if (!allReachable.has(notePath)) {
      issues.push(
        issue(
          "ORPHAN_NOTE",
          `Committed note '${notePath}' has no navigation path from root indexes.`,
          notePath,
        ),
      );
      continue;
    }

    if (!twoHopReachable.has(notePath)) {
      issues.push(
        issue(
          "UNREACHABLE_NOTE",
          `Committed note '${notePath}' is not reachable from '${ROOT_INDEX_PATH}' within two hops.`,
          notePath,
        ),
      );
    }
  }

  const report = buildValidationReport(manifest.note_contract_version, issues);
  return {
    report,
    graph,
    committed_note_paths: requiredNotes,
  };
}

export function handleValidateGraph(args: string[]): DispatchOutcome {
  const vaultRoot = args[0];
  if (vaultRoot === undefined) {
    return {
      exitCode: ExitCode.USAGE,
      result: failure("validate-graph", "USAGE_MISSING_ARGS", "Usage: validate-graph <vault-root>"),
      diagnostic: "Missing required argument for validate-graph.",
    };
  }

  try {
    const result = validateVaultGraph(vaultRoot);
    const initFailed = result.report.issues.some((entry) => entry.code === "VAULT_NOT_INITIALIZED");
    if (initFailed) {
      return {
        exitCode: ExitCode.VALIDATION,
        result: failure("validate-graph", "VAULT_NOT_INITIALIZED", result.report.summary, {
          issues: result.report.issues,
        }),
        diagnostic: result.report.summary,
      };
    }

    const exitCode = result.report.status === "pass" ? ExitCode.SUCCESS : ExitCode.VALIDATION;
    return {
      exitCode,
      result: success("validate-graph", {
        ...result.report,
        committed_note_paths: result.committed_note_paths,
        graph_nodes: result.graph.nodes.length,
        graph_edges: result.graph.edges.length,
      }),
      ...(exitCode === ExitCode.VALIDATION ? { diagnostic: result.report.summary } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Graph validation failed";
    return {
      exitCode: ExitCode.UNEXPECTED,
      result: failure("validate-graph", "VALIDATE_GRAPH_FAILED", message),
      diagnostic: message,
    };
  }
}
