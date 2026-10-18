import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const electron = require("electron");
const desktop = NodeURL.fileURLToPath(new URL("..", import.meta.url));

function runFixture(entry, profile, stage, flavor) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = NodeChildProcess.spawn(electron, [entry, profile, stage, flavor], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    process.stdout.write(`Electron fixture PID ${child.pid} started: ${flavor} ${stage}\n`);
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      process.stdout.write(
        `Electron fixture PID ${child.pid} exited ${code ?? signal}: ${flavor} ${stage}\n`,
      );
      if (code === 0) {
        process.stdout.write(output);
        resolve(output);
      } else reject(new Error(`Electron fixture failed (${code ?? signal}): ${output}`));
    });
  });
}

it("preserves Azure app storage through native Chromium, interruption, quota, cancellation and restart", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-origin-migration-"));
  try {
    await build({
      config: false,
      cwd: desktop,
      entry: ["scripts/fixtures/origin-migration.ts"],
      outDir: NodePath.join(directory, "bundle"),
      format: "esm",
      dts: false,
      sourcemap: false,
      logLevel: "silent",
      outExtensions: () => ({ js: ".mjs" }),
      deps: {
        alwaysBundle: (id) => id !== "electron" && !id.startsWith("node:"),
        neverBundle: ["electron"],
        onlyBundle: false,
      },
    });
    for (const flavor of ["production", "development"]) {
      const profile = NodePath.join(directory, flavor);
      await NodeFSP.mkdir(profile);
      for (const stage of ["exercise", "restart"]) {
        const output = await runFixture(
          NodePath.join(directory, "bundle/origin-migration.mjs"),
          profile,
          stage,
          flavor,
        );
        expect(output).toContain(`origin migration ${flavor} ${stage}: passed (Electron 44.4.5)`);
        const migrations =
          stage === "exercise"
            ? [
                "empty source",
                "pre-aborted",
                "interrupted flush",
                "constructor abort",
                "quota failure",
                "populated source",
                "already migrated",
              ]
            : ["restart"];
        for (const migration of migrations)
          expect(output).toContain(`native startup continued after migration: ${migration}`);
        expect(output).not.toContain("native before-quit during migration");
        expect(output).toContain("frontend loaded after migration returned");
        expect(output).toContain("normal frontend close requested app quit");
      }
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
}, 120_000);
