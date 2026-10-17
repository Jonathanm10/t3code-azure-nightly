import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import { build } from "vite-plus/pack";
import { assert, it } from "vite-plus/test";

import desktopConfig from "../vite.config.ts";

it("keeps lazy Linux imports and worker bundles from executing desktop startup twice", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-bundle-"));
  try {
    const workerEntries = [
      "src/electron/WindowsForegroundFocusWorker.ts",
      "src/snapShot/GlobalShiftShortcutWorker.ts",
      "src/snapShot/RegionSnapShotWorker.ts",
      "src/snapShot/SnapShotAccessibilityWorker.ts",
    ];
    await Promise.all([
      NodeFSP.mkdir(NodePath.join(directory, "src/electron"), { recursive: true }),
      NodeFSP.mkdir(NodePath.join(directory, "src/snapShot"), { recursive: true }),
    ]);
    await Promise.all([
      NodeFSP.writeFile(
        NodePath.join(directory, "src/main.ts"),
        `import { shared } from "./shared.ts";
process.emit("startup", shared.value);
void import("./linux.ts").then(({ result }) => process.emit("ready", result));`,
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/shared.ts"),
        "export const shared = { value: 42 };",
      ),
      NodeFSP.writeFile(
        NodePath.join(directory, "src/linux.ts"),
        'import { shared } from "./shared.ts"; export const result = shared.value + 1;',
      ),
      ...workerEntries.map((entry) =>
        NodeFSP.writeFile(
          NodePath.join(directory, entry),
          'import { shared } from "../shared.ts"; process.emit("worker", shared.value);',
        ),
      ),
    ]);
    assert.ok(Array.isArray(desktopConfig.pack));
    const fixtureEntries = new Set(["src/main.ts", ...workerEntries]);
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => fixtureEntries.has(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: directory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }

    const outputDirectory = NodePath.join(directory, "dist-electron");
    const filenames = (await NodeFSP.readdir(outputDirectory, { recursive: true })).filter(
      (filename) => filename.endsWith(".cjs"),
    );
    const sources = new Map(
      await Promise.all(
        filenames.map(async (filename) => {
          const path = NodePath.join(outputDirectory, filename);
          return [path, await NodeFSP.readFile(path, "utf8")];
        }),
      ),
    );
    const modules = new Map();
    const startups = [];
    const workers = [];
    const ready = Promise.withResolvers();
    const load = (filename, cacheModule = true) => {
      const cached = modules.get(filename);
      if (cached) return cached.exports;
      const module = { exports: {} };
      if (cacheModule) modules.set(filename, module);
      const source = sources.get(filename);
      assert.ok(source, `Missing bundle: ${filename}`);
      NodeVM.runInNewContext(source, {
        exports: module.exports,
        module,
        require: (specifier) => load(NodePath.resolve(NodePath.dirname(filename), specifier)),
        process: {
          emit: (event, value) => {
            if (event === "startup") startups.push(value);
            if (event === "worker") workers.push(value);
            if (event === "ready") ready.resolve(value);
          },
        },
      });
      return module.exports;
    };

    load(NodePath.join(outputDirectory, "main.cjs"), false);
    assert.equal(await ready.promise, 43);
    assert.deepEqual(startups, [42]);
    for (const entry of workerEntries) {
      load(NodePath.join(outputDirectory, entry.replace(/^src\//, "").replace(/\.ts$/, ".cjs")));
    }
    assert.deepEqual(workers, [42, 42, 42, 42]);
    assert.deepEqual(startups, [42]);
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("loads the emitted packaged boot entry and backend cache preload", async () => {
  const directory = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-desktop-boot-")),
  );
  try {
    const entries = new Set(["src/boot.ts", "src/compileCache.ts", "src/profileBootstrap.ts"]);
    const outputDirectory = NodePath.join(directory, "dist-electron");
    const profileRoot = NodePath.join(directory, ".t3-desktop-isolated", "bundle-proof");
    const application = NodePath.join(profileRoot, "Applications", "T3 Code (Azure Nightly).app");
    const executable = NodePath.join(application, "Contents", "MacOS", "T3 Code (Azure Nightly)");
    await NodeFSP.mkdir(NodePath.dirname(executable), { recursive: true });
    await NodeFSP.writeFile(executable, "fixture");
    await NodeFSP.writeFile(
      NodePath.join(application, "Contents", "Info.plist"),
      "<plist><dict><key>CFBundleIdentifier</key><string>com.jonathanm10.t3code.azure</string></dict></plist>",
    );
    await NodeFSP.writeFile(
      NodePath.join(profileRoot, "profile.json"),
      JSON.stringify({
        version: 1,
        profileId: "bundle-proof",
        bundleId: "com.jonathanm10.t3code.azure",
        appName: "T3 Code (Azure Nightly).app",
      }),
    );
    assert.ok(Array.isArray(desktopConfig.pack));
    for (const packConfig of desktopConfig.pack) {
      if (!Array.isArray(packConfig.entry)) continue;
      if (!packConfig.entry.some((entry) => entries.has(entry))) continue;
      await build({
        ...packConfig,
        config: false,
        cwd: NodeURL.fileURLToPath(new URL("..", import.meta.url)),
        outDir: outputDirectory,
        tsconfig: false,
        sourcemap: false,
        onSuccess: undefined,
        logLevel: "silent",
      });
    }
    const electronDirectory = NodePath.join(outputDirectory, "node_modules", "electron");
    await NodeFSP.mkdir(electronDirectory, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(electronDirectory, "index.js"),
      `exports.app = {
  isPackaged: true,
  paths: {},
  getVersion: () => "test",
  setName(name) { this.name = name; },
  setPath(name, target) { this.paths[name] = target; },
  setAsDefaultProtocolClient: () => true,
};`,
    );
    const fixture = `const assert = require("node:assert/strict");
const { join } = require("node:path");
const { app } = require("electron");
const profileRoot = ${JSON.stringify(profileRoot)};
assert.equal(app.name, "T3 Code Azure Nightly Proof bundle-proof");
assert.equal(app.paths.userData, join(profileRoot, "data", "electron", "userData"));
assert.equal(app.paths.sessionData, join(profileRoot, "data", "electron", "sessionData"));
assert.equal(process.env.T3CODE_HOME, join(profileRoot, "data", "backend"));
assert.equal(process.env.T3CODE_FORK_ISOLATED, "1");
assert.equal(app.setAsDefaultProtocolClient("t3code-azure"), false);
const diagnostic = require(join(profileRoot, "data", "backend", "desktop-profile.json"));
assert.equal(diagnostic.safeStorageService, app.name + " Safe Storage");
console.log(require("node:module").getCompileCacheDir() ? "cached" : "uncached");`;
    await NodeFSP.writeFile(NodePath.join(outputDirectory, "main.cjs"), fixture);
    await NodeFSP.writeFile(
      NodePath.join(outputDirectory, "backend.mjs"),
      `import { getCompileCacheDir } from 'node:module'; console.log(getCompileCacheDir() ? 'cached' : 'uncached');`,
    );
    for (const disabled of [false, true]) {
      for (const args of [
        [
          "-e",
          `process.execPath = ${JSON.stringify(executable)}; process.versions.electron = "44.4.5"; require(${JSON.stringify(NodePath.join(outputDirectory, "boot.cjs"))});`,
        ],
        [
          "--require",
          NodePath.join(outputDirectory, "compileCache.cjs"),
          NodePath.join(outputDirectory, "backend.mjs"),
        ],
      ]) {
        const child = NodeChildProcess.spawnSync(process.execPath, args, {
          cwd: directory,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: directory,
            USERPROFILE: directory,
            T3CODE_HOME: NodePath.join(directory, "ambient-home"),
            T3CODE_FORK_COMPILE_CACHE: NodePath.join(profileRoot, "data", "compile-cache"),
            APPIMAGE: "",
            NODE_PATH: undefined,
            NODE_COMPILE_CACHE: undefined,
            NODE_DISABLE_COMPILE_CACHE: disabled ? "1" : undefined,
            XDG_CACHE_HOME: directory,
            TMPDIR: directory,
            TEMP: directory,
            TMP: directory,
          },
        });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), disabled ? "uncached" : "cached");
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
