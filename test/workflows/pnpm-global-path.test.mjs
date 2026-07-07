import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePathEntries,
  isDirectoryOnPath,
  getPnpmGlobalBinDir,
  assertPnpmGlobalBinOnPath,
  formatGlobalBinNotOnPathRemediation,
  parseGlobalBinDirFromPnpmError,
  getExecutablePath,
  PNPM_GLOBAL_LINK_ARGS,
  renderUnixLauncherContent,
  renderWindowsCmdLauncherContent,
  isManagedLauncherContent,
  writeLauncherFile,
  checkCompiledCliArtifacts,
} from "../../scripts/pnpm-global-path.mjs";

describe("pnpm global bin PATH helpers (unit)", () => {
  it("parsePathEntries splits PATH by platform separator", () => {
    assert.deepEqual(parsePathEntries("/usr/bin:/usr/local/bin"), ["/usr/bin", "/usr/local/bin"]);
    assert.deepEqual(parsePathEntries(""), []);
  });

  it("isDirectoryOnPath compares normalized entries", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const normalize = (entry) => entry.replace(/\/+$/, "");
    const pathEnv = "/usr/bin:/Users/test/Library/pnpm/bin:/opt/homebrew/bin";

    assert.equal(isDirectoryOnPath(globalBin, pathEnv, normalize), true);
    assert.equal(isDirectoryOnPath(globalBin, "/usr/bin:/opt/homebrew/bin", normalize), false);
  });

  it("getPnpmGlobalBinDir reads stdout from mocked pnpm bin -g", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const spawnSyncFn = (command, args) => {
      assert.equal(command, "pnpm");
      assert.deepEqual(args, ["bin", "-g"]);
      return { status: 0, stdout: `${globalBin}\n` };
    };

    assert.equal(getPnpmGlobalBinDir(spawnSyncFn), globalBin);
  });

  it("getPnpmGlobalBinDir parses path from pnpm not-in-PATH error", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const spawnSyncFn = () => ({
      status: 1,
      stderr: `[ERROR] The configured global bin directory "${globalBin}" is not in PATH\nRun "pnpm setup" to update your shell configuration.\n`,
    });

    assert.equal(getPnpmGlobalBinDir(spawnSyncFn), globalBin);
  });

  it("parseGlobalBinDirFromPnpmError extracts quoted directory", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const message = `[ERROR] The configured global bin directory "${globalBin}" is not in PATH`;
    assert.equal(parseGlobalBinDirFromPnpmError(message), globalBin);
    assert.equal(parseGlobalBinDirFromPnpmError("other failure"), null);
  });

  it("assertPnpmGlobalBinOnPath fails early when global bin is missing from PATH", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const spawnSyncFn = () => ({
      status: 1,
      stderr: `[ERROR] The configured global bin directory "${globalBin}" is not in PATH\n`,
    });
    const result = assertPnpmGlobalBinOnPath({
      spawnSyncFn,
      pathEnv: "/usr/bin:/opt/homebrew/bin",
      normalize: (entry) => entry,
    });

    assert.equal(result.ok, false);
    assert.equal(result.globalBinDir, globalBin);
    assert.match(result.message, /pnpm run setup/i);
    assert.match(result.message, new RegExp(globalBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("assertPnpmGlobalBinOnPath passes when global bin is on PATH", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const spawnSyncFn = () => ({ status: 0, stdout: `${globalBin}\n` });
    const result = assertPnpmGlobalBinOnPath({
      spawnSyncFn,
      pathEnv: `/usr/bin:${globalBin}:/opt/homebrew/bin`,
      normalize: (entry) => entry,
    });

    assert.equal(result.ok, true);
    assert.equal(result.globalBinDir, globalBin);
  });

  it("PNPM_GLOBAL_LINK_ARGS uses pnpm 11 global link from package root", () => {
    assert.deepEqual(PNPM_GLOBAL_LINK_ARGS, ["link", "--global", "."]);
  });

  it("formatGlobalBinNotOnPathRemediation includes export PATH on unix", () => {
    if (process.platform === "win32") {
      return;
    }
    const message = formatGlobalBinNotOnPathRemediation("/Users/test/Library/pnpm/bin");
    assert.match(message, /export PATH="\/Users\/test\/Library\/pnpm\/bin:\$PATH"/);
  });

  it("formatGlobalBinNotOnPathRemediation includes shell-specific guidance on unix", () => {
    if (process.platform === "win32") {
      return;
    }
    const message = formatGlobalBinNotOnPathRemediation("/Users/test/Library/pnpm/bin");
    assert.match(message, /## zsh/);
    assert.match(message, /## bash/);
    assert.match(message, /## fish/);
    assert.match(message, /~\/.zshrc/);
    assert.match(message, /~\/.bashrc/);
    assert.match(message, /fish_user_paths/);
  });

  it("formatGlobalBinNotOnPathRemediation includes resolved bin dir and rerun instruction", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const message = formatGlobalBinNotOnPathRemediation(globalBin);
    assert.match(message, new RegExp(globalBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(message, /pnpm run setup/);
  });

  it("formatGlobalBinNotOnPathRemediation includes set PATH on windows", () => {
    if (process.platform !== "win32") {
      return;
    }
    const message = formatGlobalBinNotOnPathRemediation("C:\\Users\\test\\pnpm\\bin");
    assert.match(message, /set PATH=%PATH%;C:\\Users\\test\\pnpm\\bin/);
  });

  it("getExecutablePath returns .cmd extension on windows", () => {
    const testPath = getExecutablePath("/test/bin", "okv");
    const isWindows = process.platform === "win32";
    if (isWindows) {
      assert.equal(testPath, "\\test\\bin\\okv.cmd");
    } else {
      assert.equal(testPath, "/test/bin/okv");
    }
  });

  it("getExecutablePath handles okv executable", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const path = getExecutablePath(globalBin, "okv");
    if (process.platform === "win32") {
      assert.match(path, /okv\.cmd$/);
    } else {
      assert.match(path, /\/okv$/);
      assert.equal(path, `${globalBin}/okv`);
    }
  });

  it("getExecutablePath handles okf-vault executable", () => {
    const globalBin = "/Users/test/Library/pnpm/bin";
    const path = getExecutablePath(globalBin, "okf-vault");
    if (process.platform === "win32") {
      assert.match(path, /okf-vault\.cmd$/);
    } else {
      assert.match(path, /\/okf-vault$/);
      assert.equal(path, `${globalBin}/okf-vault`);
    }
  });
});

describe("launcher rendering helpers (unit)", () => {
  it("renderUnixLauncherContent generates shebang and exec invocation", () => {
    const entryPoint = "/path/to/dist/main.js";
    const content = renderUnixLauncherContent(entryPoint);
    assert.match(content, /^#!/);
    assert.match(content, /\/bin\/sh/);
    assert.match(content, /exec/);
    assert.match(content, /dist\/main\.js/);
    assert.match(content, /\$@/);
  });

  it("renderUnixLauncherContent includes process.execPath (node executable)", () => {
    const entryPoint = "/path/to/dist/main.js";
    const content = renderUnixLauncherContent(entryPoint);
    assert.match(content, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("renderUnixLauncherContent for okv targets dist/main.js", () => {
    const mainJsPath = "/repo/dist/main.js";
    const content = renderUnixLauncherContent(mainJsPath);
    assert.match(content, /dist\/main\.js/);
    assert.equal(content.includes("/repo/dist/main.js"), true);
  });

  it("renderUnixLauncherContent for okf-vault targets dist/tombstone.js", () => {
    const tombstonePath = "/repo/dist/tombstone.js";
    const content = renderUnixLauncherContent(tombstonePath);
    assert.match(content, /dist\/tombstone\.js/);
    assert.equal(content.includes("/repo/dist/tombstone.js"), true);
  });

  it("renderWindowsCmdLauncherContent generates batch syntax", () => {
    const entryPoint = "C:\\path\\to\\dist\\main.js";
    const content = renderWindowsCmdLauncherContent(entryPoint);
    assert.match(content, /@echo off/);
    assert.match(content, /node\.exe/);
    assert.match(content, /%\*/);
    assert.match(content, /main\.js/);
  });

  it("renderWindowsCmdLauncherContent for okv targets dist/main.js", () => {
    const mainJsPath = "C:\\repo\\dist\\main.js";
    const content = renderWindowsCmdLauncherContent(mainJsPath);
    assert.match(content, /dist\\main\.js/);
    assert.equal(content.includes("C:\\repo\\dist\\main.js"), true);
  });

  it("renderWindowsCmdLauncherContent for okf-vault targets dist/tombstone.js", () => {
    const tombstonePath = "C:\\repo\\dist\\tombstone.js";
    const content = renderWindowsCmdLauncherContent(tombstonePath);
    assert.match(content, /dist\\tombstone\.js/);
    assert.equal(content.includes("C:\\repo\\dist\\tombstone.js"), true);
  });

  it("isManagedLauncherContent returns true for matching Unix content", () => {
    const entryPoint = "/path/to/dist/main.js";
    const expected = renderUnixLauncherContent(entryPoint);
    const isManaged = isManagedLauncherContent(expected, entryPoint);
    if (process.platform === "win32") {
      return;
    }
    assert.equal(isManaged, true);
  });

  it("isManagedLauncherContent returns true for matching Windows content", () => {
    const entryPoint = "C:\\path\\to\\dist\\main.js";
    const expected = renderWindowsCmdLauncherContent(entryPoint);
    const isManaged = isManagedLauncherContent(expected, entryPoint);
    if (process.platform !== "win32") {
      return;
    }
    assert.equal(isManaged, true);
  });

  it("isManagedLauncherContent returns false for unrelated content", () => {
    const entryPoint = "/path/to/dist/main.js";
    const unrelatedContent = "#!/bin/sh\necho hello";
    const isManaged = isManagedLauncherContent(unrelatedContent, entryPoint);
    assert.equal(isManaged, false);
  });

  it("isManagedLauncherContent returns false for content with wrong entry point", () => {
    const entryPoint = "/path/to/dist/main.js";
    const wrongEntryContent = renderUnixLauncherContent("/different/entry/point.js");
    const isManaged = isManagedLauncherContent(wrongEntryContent, entryPoint);
    if (process.platform === "win32") {
      return;
    }
    assert.equal(isManaged, false);
  });

  it("isManagedLauncherContent uses platform-specific check on windows", () => {
    const unixContent = '#!/bin/sh\nexec node /path/to/main.js "$@"';
    const windowsEntryPoint = "C:\\path\\to\\dist\\main.js";
    const isManaged = isManagedLauncherContent(unixContent, windowsEntryPoint);
    if (process.platform !== "win32") {
      return;
    }
    assert.equal(isManaged, false);
  });
});

describe("launcher write and compilation artifact checks (unit)", () => {
  it("writeLauncherFile skips already-current managed launcher content", () => {
    const entryPoint = "/path/to/dist/main.js";
    const expectedContent =
      process.platform === "win32"
        ? `@echo off\nnode.exe "${entryPoint}" %*\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${entryPoint}" "$@"\n`;

    let readCalled = false;
    let writeCalled = false;

    const mockFs = {
      readFileSync: () => {
        readCalled = true;
        return expectedContent;
      },
      writeFileSync: () => {
        writeCalled = true;
      },
      chmodSync: () => {},
    };

    const result = writeLauncherFile("/test/bin/okv", entryPoint, mockFs);

    assert.equal(readCalled, true);
    assert.equal(writeCalled, false);
    assert.equal(result.written, false);
    assert.match(result.reason, /already current/);
  });

  it("writeLauncherFile replaces stale managed launcher content", () => {
    const entryPoint = "/path/to/dist/main.js";
    const staleContent = "#!/bin/sh\necho old";

    let readCalled = false;
    let writeCalled = false;
    let chmodCalled = false;
    let writtenContent = null;

    const mockFs = {
      readFileSync: () => {
        readCalled = true;
        return staleContent;
      },
      writeFileSync: (path, content) => {
        writeCalled = true;
        writtenContent = content;
      },
      chmodSync: () => {
        if (process.platform !== "win32") {
          chmodCalled = true;
        }
      },
    };

    const result = writeLauncherFile("/test/bin/okv", entryPoint, mockFs);

    assert.equal(readCalled, true);
    assert.equal(writeCalled, true);
    assert.equal(result.written, true);
    if (process.platform !== "win32") {
      assert.equal(chmodCalled, true);
    }
    assert.match(writtenContent, /exec/);
  });

  it("writeLauncherFile writes new launcher when file does not exist", () => {
    const entryPoint = "/path/to/dist/main.js";

    let writeCalled = false;
    let writtenContent = null;

    const mockFs = {
      readFileSync: () => {
        const error = new Error("ENOENT");
        throw error;
      },
      writeFileSync: (path, content) => {
        writeCalled = true;
        writtenContent = content;
      },
      chmodSync: () => {},
    };

    const result = writeLauncherFile("/test/bin/okv", entryPoint, mockFs);

    assert.equal(writeCalled, true);
    assert.equal(result.written, true);
    assert.match(writtenContent, /exec/);
  });

  it("checkCompiledCliArtifacts returns ok when both dist files exist", () => {
    const mockExists = (path) => {
      return path.includes("main.js") || path.includes("tombstone.js");
    };

    const result = checkCompiledCliArtifacts("/repo/dist", { existsSync: mockExists });

    assert.equal(result.ok, true);
  });

  it("checkCompiledCliArtifacts reports missing main.js", () => {
    const mockExists = (path) => {
      return path.includes("tombstone.js");
    };

    const result = checkCompiledCliArtifacts("/repo/dist", { existsSync: mockExists });

    assert.equal(result.ok, false);
    assert.match(result.missingEntries.join(","), /main\.js/);
  });

  it("checkCompiledCliArtifacts reports missing tombstone.js", () => {
    const mockExists = (path) => {
      return path.includes("main.js");
    };

    const result = checkCompiledCliArtifacts("/repo/dist", { existsSync: mockExists });

    assert.equal(result.ok, false);
    assert.match(result.missingEntries.join(","), /tombstone\.js/);
  });

  it("checkCompiledCliArtifacts reports both missing when neither exists", () => {
    const mockExists = () => false;

    const result = checkCompiledCliArtifacts("/repo/dist", { existsSync: mockExists });

    assert.equal(result.ok, false);
    assert.equal(result.missingEntries.length, 2);
    assert.match(result.missingEntries.join(","), /main\.js/);
    assert.match(result.missingEntries.join(","), /tombstone\.js/);
  });
});
