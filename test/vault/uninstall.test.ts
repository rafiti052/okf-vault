import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ExitCode, dispatch, parseArgs, type CliSuccess } from "../../dist/cli/cli.js";
import {
  type ManagedArtifact,
  type UninstallResult,
  uninstallManagedArtifacts,
} from "../../dist/vault/uninstall.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function emptyManifest(): { managed: ManagedArtifact[]; legacy: ManagedArtifact[] } {
  return { managed: [], legacy: [] };
}

function uninstallData(outcome: ReturnType<typeof dispatch>): UninstallResult {
  assert.equal(outcome.result?.status, "ok");
  return (outcome.result as CliSuccess).data as UninstallResult;
}

function withCwd<T>(cwd: string, fn: () => T): T {
  const original = process.cwd();
  process.chdir(cwd);
  try {
    return fn();
  } finally {
    process.chdir(original);
  }
}

function withGlobalBin<T>(globalBin: string, fn: () => T): T {
  const original = process.env.OKV_GLOBAL_BIN_DIR;
  process.env.OKV_GLOBAL_BIN_DIR = globalBin;
  try {
    return fn();
  } finally {
    if (original === undefined) {
      delete process.env.OKV_GLOBAL_BIN_DIR;
    } else {
      process.env.OKV_GLOBAL_BIN_DIR = original;
    }
  }
}

function seedGlobalBins(globalBin: string): void {
  mkdirSync(globalBin, { recursive: true });
  writeFileSync(join(globalBin, "okv"), "#!/bin/sh\n", "utf8");
  writeFileSync(join(globalBin, "okf-vault"), "#!/bin/sh\n", "utf8");
}

function seedNote(projectRoot: string, name = "kept.md"): string {
  const notePath = join(projectRoot, "knowledge", "notes", name);
  mkdirSync(dirname(notePath), { recursive: true });
  writeFileSync(notePath, "# Keep me\n", "utf8");
  return notePath;
}

function managedSymlinkPaths(data: UninstallResult): string[] {
  return data.removed
    .filter((item) => item.kind === "symlink" && item.legacy !== true && item.path !== undefined)
    .map((item) => item.path as string)
    .sort();
}

describe("uninstall unit behavior", () => {
  it("dry-run previews removal targets and performs zero rm calls", () => {
    const projectRoot = tempRoot("okv-uninstall-dry-");
    const target = join(projectRoot, ".cursor", "skills", "okf-vault");
    const managed: ManagedArtifact[] = [
      { kind: "symlink", label: "Cursor umbrella skill", path: target },
      { kind: "global-bin", label: "Primary OKV global binary", name: "okv" },
    ];
    let rmCalls = 0;

    const outcome = uninstallManagedArtifacts(["--dry-run"], {
      projectRoot,
      globalBinDir: join(projectRoot, "bin"),
      manifestProvider: () => ({ managed, legacy: [] }),
      legacySweeper: () => ({ removed: [] }),
      fsImpl: {
        lstatSync: ((path: string) => {
          if (path !== target) {
            throw new Error("missing");
          }
          return { isSymbolicLink: () => true, isDirectory: () => false };
        }) as typeof lstatSync,
        rmSync: (() => {
          rmCalls += 1;
        }) as unknown as typeof rmSync,
        readdirSync,
      },
    });

    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    const data = (outcome.result as CliSuccess).data as UninstallResult;
    assert.equal(data.dry_run, true);
    assert.equal(data.removed.length, 1);
    assert.equal(data.removed[0]?.path, target);
    assert.equal(data.skipped[0]?.name, "okv");
    assert.match(data.skipped[0]?.reason ?? "", /dry-run/);
    assert.equal(rmCalls, 0);
  });

  it("--purge without --yes in non-TTY exits usage and keeps metadata", () => {
    const projectRoot = tempRoot("okv-uninstall-purge-gate-");
    const metadata = join(projectRoot, ".okf-vault");
    mkdirSync(metadata, { recursive: true });
    writeFileSync(join(metadata, "manifest.json"), "{}", "utf8");

    const outcome = uninstallManagedArtifacts(["--purge"], {
      projectRoot,
      manifestProvider: emptyManifest,
      legacySweeper: () => ({ removed: [] }),
      globalBinDir: join(projectRoot, "bin"),
      stdin: { isTTY: false },
    });

    assert.equal(outcome.exitCode, ExitCode.USAGE);
    assert.equal(outcome.result?.status, "error");
    assert.equal(existsSync(join(metadata, "manifest.json")), true);
    assert.deepEqual((outcome.result?.details as { removed: unknown[] }).removed, []);
  });

  it("--purge --yes removes only .okf-vault metadata and leaves notes", () => {
    const projectRoot = tempRoot("okv-uninstall-purge-yes-");
    const notePath = seedNote(projectRoot);
    const metadata = join(projectRoot, "knowledge", ".okf-vault");
    mkdirSync(metadata, { recursive: true });
    writeFileSync(join(metadata, "manifest.json"), "{}", "utf8");

    const outcome = uninstallManagedArtifacts(["--purge", "--yes"], {
      projectRoot,
      manifestProvider: emptyManifest,
      legacySweeper: () => ({ removed: [] }),
      globalBinDir: join(projectRoot, "bin"),
      stdin: { isTTY: false },
    });

    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    assert.equal(existsSync(metadata), false);
    assert.equal(existsSync(notePath), true);
  });

  it("includes present legacy stub paths in dry-run removal preview", () => {
    const projectRoot = tempRoot("okv-uninstall-legacy-preview-");
    const legacyStub = join(projectRoot, ".cursor", "skills", "vault-ingest", "SKILL.md");
    mkdirSync(dirname(legacyStub), { recursive: true });
    writeFileSync(legacyStub, "# legacy\n", "utf8");

    const outcome = uninstallManagedArtifacts(["--dry-run"], {
      projectRoot,
      manifestProvider: () => ({
        managed: [],
        legacy: [
          {
            kind: "symlink",
            label: "Legacy Cursor /vault-ingest",
            path: legacyStub,
            legacy: true,
          },
        ],
      }),
      legacySweeper: () => ({ removed: [] }),
      globalBinDir: join(projectRoot, "bin"),
    });

    const data = (outcome.result as CliSuccess).data as UninstallResult;
    assert.equal(data.removed[0]?.path, legacyStub);
    assert.equal(data.removed[0]?.legacy, true);
    assert.equal(existsSync(legacyStub), true);
  });

  it("populates errors when a target cannot be removed", () => {
    const projectRoot = tempRoot("okv-uninstall-error-");
    const target = join(projectRoot, ".cursor", "skills", "okf-vault");
    const managed: ManagedArtifact[] = [
      { kind: "symlink", label: "Cursor umbrella skill", path: target },
    ];

    const outcome = uninstallManagedArtifacts([], {
      projectRoot,
      manifestProvider: () => ({ managed, legacy: [] }),
      legacySweeper: () => ({ removed: [] }),
      globalBinDir: join(projectRoot, "bin"),
      fsImpl: {
        lstatSync: ((path: string) => {
          if (path !== target) {
            throw new Error("missing");
          }
          return { isSymbolicLink: () => true, isDirectory: () => false };
        }) as typeof lstatSync,
        rmSync: (() => {
          throw new Error("permission denied");
        }) as typeof rmSync,
        readdirSync,
      },
    });

    assert.equal(outcome.exitCode, ExitCode.UNEXPECTED);
    const data = (outcome.result as CliSuccess).data as UninstallResult;
    assert.equal(data.errors.length, 1);
    assert.match(data.errors[0]?.error ?? "", /permission denied/);
  });

  it("sweeps npm and pnpm global directories for legacy binaries when confirmed", () => {
    const projectRoot = tempRoot("okv-uninstall-global-confirm-");
    const pnpmBin = join(projectRoot, "pnpm-bin");
    const npmPrefix = join(projectRoot, "npm-prefix");
    const npmBin = join(npmPrefix, "bin");
    for (const dir of [pnpmBin, npmBin]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "okv"), "#!/bin/sh\n", "utf8");
      writeFileSync(join(dir, "okf-vault"), "#!/bin/sh\n", "utf8");
      writeFileSync(join(dir, "okv-cli"), "#!/bin/sh\n", "utf8");
    }

    let prompts = 0;
    const outcome = uninstallManagedArtifacts([], {
      projectRoot,
      manifestProvider: () => ({
        managed: [{ kind: "global-bin", label: "Primary OKV global binary", name: "okv" }],
        legacy: [
          {
            kind: "global-bin",
            label: "Legacy full CLI global binary",
            name: "okf-vault",
            legacy: true,
          },
        ],
      }),
      legacySweeper: () => ({ removed: [] }),
      stdout: { isTTY: true },
      env: {},
      commandRunner: (command, args) => {
        if (command === "pnpm" && args.join(" ") === "config get global-bin-dir") {
          return { status: 0, stdout: pnpmBin };
        }
        if (command === "pnpm" && args.join(" ") === "bin -g") {
          return { status: 0, stdout: pnpmBin };
        }
        if (command === "npm" && args.join(" ") === "config get prefix -g") {
          return { status: 0, stdout: npmPrefix };
        }
        return { status: 1, stdout: "" };
      },
      readConfirmation: () => {
        prompts += 1;
        return "yes";
      },
    });

    assert.equal(outcome.exitCode, ExitCode.SUCCESS);
    assert.equal(prompts, 4);
    for (const dir of [pnpmBin, npmBin]) {
      assert.equal(existsSync(join(dir, "okv")), false);
      assert.equal(existsSync(join(dir, "okf-vault")), false);
      assert.equal(existsSync(join(dir, "okv-cli")), false);
    }
  });

  it("bypasses legacy prompts in non-TTY and CI runs", () => {
    for (const scenario of [
      { label: "non-tty", stdout: { isTTY: false }, env: {} },
      { label: "ci", stdout: { isTTY: true }, env: { CI: "true" } },
    ]) {
      const projectRoot = tempRoot(`okv-uninstall-headless-${scenario.label}-`);
      const globalBin = join(projectRoot, "global-bin");
      mkdirSync(globalBin, { recursive: true });
      writeFileSync(join(globalBin, "okf-vault"), "#!/bin/sh\n", "utf8");
      writeFileSync(join(globalBin, "okv-cli"), "#!/bin/sh\n", "utf8");

      const outcome = uninstallManagedArtifacts([], {
        projectRoot,
        manifestProvider: emptyManifest,
        legacySweeper: () => ({ removed: [] }),
        globalBinDirs: [globalBin],
        stdout: scenario.stdout,
        env: scenario.env,
        readConfirmation: () => {
          throw new Error(`prompted during ${scenario.label}`);
        },
      });

      assert.equal(outcome.exitCode, ExitCode.SUCCESS);
      assert.equal(existsSync(join(globalBin, "okf-vault")), false);
      assert.equal(existsSync(join(globalBin, "okv-cli")), false);
    }
  });

  it("reports global binary permission failures with unexpected exit code", () => {
    const projectRoot = tempRoot("okv-uninstall-global-error-");
    const globalBin = join(projectRoot, "global-bin");
    const legacyBin = join(globalBin, "okv-cli");
    const managed: ManagedArtifact[] = [
      { kind: "global-bin", label: "Legacy okv-cli global binary", name: "okv-cli", legacy: true },
    ];

    const outcome = uninstallManagedArtifacts([], {
      projectRoot,
      manifestProvider: () => ({ managed, legacy: [] }),
      legacySweeper: () => ({ removed: [] }),
      globalBinDirs: [globalBin],
      stdout: { isTTY: false },
      fsImpl: {
        lstatSync: ((path: string) => {
          if (path !== legacyBin) {
            throw new Error("missing");
          }
          return { isSymbolicLink: () => false, isDirectory: () => false };
        }) as typeof lstatSync,
        rmSync: (() => {
          throw new Error("permission denied");
        }) as typeof rmSync,
        readdirSync,
      },
    });

    assert.equal(outcome.exitCode, ExitCode.UNEXPECTED);
    const data = (outcome.result as CliSuccess).data as UninstallResult;
    assert.equal(data.errors.length, 1);
    assert.equal(data.errors[0]?.path, legacyBin);
    assert.match(data.errors[0]?.error ?? "", /permission denied/);
  });
});

describe("uninstall integration behavior", () => {
  it("default uninstall removes adapters, curator rule, and global bins while preserving notes", () => {
    const projectRoot = tempRoot("okv-uninstall-default-");
    const globalBin = join(projectRoot, "global-bin");
    seedGlobalBins(globalBin);

    withGlobalBin(globalBin, () =>
      withCwd(projectRoot, () => {
        assert.equal(dispatch(parseArgs(["init"])).exitCode, ExitCode.SUCCESS);
        const notePath = seedNote(projectRoot);

        const outcome = dispatch(parseArgs(["uninstall"]));

        assert.equal(outcome.exitCode, ExitCode.SUCCESS);
        assert.equal(existsSync(join(projectRoot, ".cursor", "skills", "okf-vault")), false);
        assert.equal(existsSync(join(projectRoot, ".claude", "skills", "okf-vault")), false);
        assert.equal(existsSync(join(projectRoot, ".cursor", "rules", "okv.mdc")), false);
        assert.equal(existsSync(join(globalBin, "okv")), false);
        assert.equal(existsSync(join(globalBin, "okf-vault")), false);
        assert.equal(existsSync(notePath), true);
      }),
    );
  });

  it("init then uninstall leaves adapter trees clean and note directory listing preserved", () => {
    const projectRoot = tempRoot("okv-uninstall-e2e-");
    const globalBin = join(projectRoot, "global-bin");
    seedGlobalBins(globalBin);

    withGlobalBin(globalBin, () =>
      withCwd(projectRoot, () => {
        assert.equal(dispatch(parseArgs(["init"])).exitCode, ExitCode.SUCCESS);
        seedNote(projectRoot, "alpha.md");
        seedNote(projectRoot, "beta.md");
        const before = readdirSync(join(projectRoot, "knowledge", "notes")).sort();

        const outcome = dispatch(parseArgs(["uninstall"]));
        const data = uninstallData(outcome);

        assert.equal(outcome.exitCode, ExitCode.SUCCESS);
        assert.equal(
          data.removed.some((item) => item.kind === "symlink"),
          true,
        );
        assert.equal(existsSync(join(projectRoot, ".cursor", "skills", "okv-ingest")), false);
        assert.equal(existsSync(join(projectRoot, ".claude", "commands", "okv-ingest.md")), false);
        assert.deepEqual(readdirSync(join(projectRoot, "knowledge", "notes")).sort(), before);
      }),
    );
  });

  it("dry-run followed by real uninstall removes the previewed symlink set", () => {
    const projectRoot = tempRoot("okv-uninstall-preview-real-");
    const globalBin = join(projectRoot, "global-bin");
    seedGlobalBins(globalBin);

    withGlobalBin(globalBin, () =>
      withCwd(projectRoot, () => {
        assert.equal(dispatch(parseArgs(["init"])).exitCode, ExitCode.SUCCESS);
        const dryRun = uninstallData(dispatch(parseArgs(["uninstall", "--dry-run"])));
        const previewedSymlinks = managedSymlinkPaths(dryRun);

        const real = uninstallData(dispatch(parseArgs(["uninstall"])));
        const removedSymlinks = managedSymlinkPaths(real);

        assert.equal(previewedSymlinks.length, 16);
        assert.deepEqual(removedSymlinks, previewedSymlinks);
      }),
    );
  });

  it("--purge --yes after init removes metadata but preserves converted notes", () => {
    const projectRoot = tempRoot("okv-uninstall-integrated-purge-");
    const globalBin = join(projectRoot, "global-bin");
    seedGlobalBins(globalBin);

    withGlobalBin(globalBin, () =>
      withCwd(projectRoot, () => {
        assert.equal(dispatch(parseArgs(["init"])).exitCode, ExitCode.SUCCESS);
        const notePath = seedNote(projectRoot, "converted.md");
        assert.equal(
          existsSync(join(projectRoot, "knowledge", ".okf-vault", "manifest.json")),
          true,
        );

        const outcome = dispatch(parseArgs(["uninstall", "--purge", "--yes"]));

        assert.equal(outcome.exitCode, ExitCode.SUCCESS);
        assert.equal(existsSync(join(projectRoot, ".okf-vault")), false);
        assert.equal(existsSync(join(projectRoot, "knowledge", ".okf-vault")), false);
        assert.equal(existsSync(notePath), true);
      }),
    );
  });
});
