// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer through a PTY and a gated HTTP fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("installer terminal", () => {
  it.each([false, true])(
    "preserves download and install behavior (HTTP failure: %s)",
    async (fail) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-progress-"));
      const version = "1.2.3";
      const stem = `t3-${version}-linux-${HostProcess.Architecture.defaultValue()}`;
      const archiveName = `${stem}.tar.gz`;
      let resumeDownload: (() => void) | undefined;
      let sawPartialProgress = false;
      let output = "";
      await NodeFSP.mkdir(NodePath.join(root, stem));
      await NodeFSP.writeFile(NodePath.join(root, stem, "t3"), "#!/bin/sh\necho 't3 v1.2.3'\n", {
        mode: 0o755,
      });
      await NodeFSP.writeFile(
        NodePath.join(root, stem, ".release-origin"),
        `${CLI_RELEASE_REPOSITORY}\n`,
      );
      await NodeFSP.writeFile(
        NodePath.join(root, stem, ".release-provenance.json"),
        JSON.stringify({
          repository: CLI_RELEASE_REPOSITORY,
          version,
          sourceSha: "a".repeat(40),
          platformKey: `linux-${HostProcess.Architecture.defaultValue()}`,
        }),
      );
      await NodeFSP.writeFile(
        NodePath.join(root, stem, "payload"),
        NodeCrypto.randomBytes(64 * 1024),
      );
      NodeChildProcess.execFileSync("tar", [
        "-czf",
        NodePath.join(root, archiveName),
        "-C",
        root,
        stem,
      ]);
      const archive = await NodeFSP.readFile(NodePath.join(root, archiveName));
      const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
      const server = NodeHttp.createServer((request, response) => {
        if (request.url?.endsWith("/SHA256SUMS")) {
          response.end(`${checksum}  ${archiveName}\n`);
        } else if (fail) {
          response.writeHead(500).end();
        } else {
          response.writeHead(200, { "Content-Length": archive.length });
          resumeDownload = () => response.end(archive.subarray(Math.floor(archive.length / 2)));
          response.write(archive.subarray(0, Math.floor(archive.length / 2)));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
      const installer = NodePath.resolve(import.meta.dirname, "install.sh").replaceAll(
        "'",
        "'\\''",
      );
      const child = NodeChildProcess.spawn("script", ["-qec", `sh '${installer}'`, "/dev/null"], {
        env: {
          ...process.env,
          TERM: "xterm",
          NO_COLOR: "1",
          T3CODE_VERSION: version,
          T3CODE_HOME: NodePath.join(root, "home"),
          T3CODE_INSTALL_BIN_DIR: NodePath.join(root, "bin"),
          T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const collect = (chunk: Buffer) => {
        output += chunk.toString();
        if (!sawPartialProgress && /\b[1-9]\d?%/.test(output)) {
          sawPartialProgress = true;
          resumeDownload?.();
        }
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
        const versions = NodePath.join(root, "home/runtime/versions");
        if (fail) {
          expect(code).not.toBe(0);
          expect(output).toContain("500");
          expect(output).not.toContain("100%");
          expect(output).not.toContain("Installed T3 Code");
          expect(await NodeFSP.readdir(versions)).toEqual([]);
        } else {
          expect(code).toBe(0);
          expect(sawPartialProgress).toBe(true);
          expect(output).toContain("100%");
          expect(output).toContain("0.1 / 0.1 MB");
          expect(output).toContain("Installed T3 Code 1.2.3");
          expect(
            await NodeFSP.readFile(NodePath.join(versions, version, ".install-complete"), "utf8"),
          ).toBe("1.2.3\n");
          expect(
            NodeChildProcess.execFileSync(NodePath.join(root, "bin/t3"), ["--version"], {
              encoding: "utf8",
            }).trim(),
          ).toBe("t3 v1.2.3");
          const content = await NodeFSP.readlink(NodePath.join(versions, version));
          expect(NodePath.basename(content)).toBe(version);
          expect((await NodeFSP.readdir(versions)).sort()).toEqual(
            [NodePath.basename(NodePath.dirname(content)), version].sort(),
          );
        }
      } finally {
        if (child.exitCode === null) child.kill();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installer publication", () => {
  const version = "1.2.3";
  const installer = NodePath.resolve(import.meta.dirname, "install.sh");

  async function fixture() {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-install-publication-")),
    );
    const key = `${HostProcess.Platform.defaultValue()}-${HostProcess.Architecture.defaultValue()}`;
    const stem = `t3-${version}-${key}`;
    const content = NodePath.join(root, stem);
    await NodeFSP.mkdir(NodePath.join(content, "node_modules/native"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(content, "node_modules/native/payload"),
      "native-content",
    );
    await NodeFSP.writeFile(NodePath.join(content, "t3"), '#!/bin/sh\necho "fork $*"\n', {
      mode: 0o755,
    });
    await NodeFSP.writeFile(
      NodePath.join(content, ".release-origin"),
      `${CLI_RELEASE_REPOSITORY}\n`,
    );
    await NodeFSP.writeFile(
      NodePath.join(content, ".release-provenance.json"),
      JSON.stringify({
        repository: CLI_RELEASE_REPOSITORY,
        version,
        sourceSha: "a".repeat(40),
        platformKey: key,
      }),
    );
    const archiveName = `${stem}.tar.gz`;
    const archivePath = NodePath.join(root, archiveName);
    NodeChildProcess.execFileSync("tar", ["-czf", archivePath, "-C", root, stem]);
    const archive = await NodeFSP.readFile(archivePath);
    const checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
    const server = NodeHttp.createServer((request, response) => {
      response.end(
        request.url?.endsWith("/SHA256SUMS") ? `${checksum}  ${archiveName}\n` : archive,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP listener");
    const home = NodePath.join(root, "home");
    const versions = NodePath.join(home, "runtime/versions");
    const target = NodePath.join(versions, version);
    const bin = NodePath.join(root, "bin");
    const wrappers = NodePath.join(root, "wrappers");
    await NodeFSP.mkdir(wrappers);
    const run = (race = "absent") =>
      new Promise<{ code: number | null; output: string }>((resolve, reject) => {
        const child = NodeChildProcess.spawn("sh", [installer], {
          cwd: root,
          env: {
            ...process.env,
            PATH: `${wrappers}:${process.env.PATH}`,
            T3CODE_VERSION: version,
            T3CODE_HOME: "home",
            T3CODE_INSTALL_BIN_DIR: bin,
            T3CODE_RELEASE_BASE_URL: `http://127.0.0.1:${address.port}`,
            TEST_RACE: race,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, output }));
      });
    const wrapper = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const args = process.argv.slice(2), source = args.at(-2), operand = args.at(-1);
const dest = operand.endsWith("/") ? path.join(operand, path.basename(source)) : operand;
const target = ${JSON.stringify(target)}, root = ${JSON.stringify(root)};
const kind = process.env.TEST_RACE;
if (dest === target && !["absent", "signal"].includes(kind)) {
  if (kind === "dangling") fs.symlinkSync(path.join(root, "missing"), target);
  else if (kind === "empty") fs.mkdirSync(target);
  else {
    fs.cpSync(source, target, { recursive: true });
    fs.writeFileSync(path.join(target, "t3"), kind === "valid" ? '#!/bin/sh\\necho "winner $*"\\n' : '#!/bin/sh\\ntouch "' + root + '/foreign-executed"\\n');
    if (kind === "foreign") fs.writeFileSync(path.join(target, ".release-origin"), "pingdotgg/t3code\\n");
  }
  fs.writeFileSync(path.join(root, "collision.json"), JSON.stringify({
    ino: fs.lstatSync(target).ino,
    children: kind === "dangling" ? [] : fs.readdirSync(target).sort(),
  }));
}
const result = cp.spawnSync("/bin/ln", args, { stdio: "inherit" });
if (dest === target && kind === "signal" && result.status === 0) process.kill(process.ppid, "SIGTERM");
process.exit(result.status ?? 1);
`;
    await NodeFSP.writeFile(NodePath.join(wrappers, "ln"), wrapper, { mode: 0o755 });
    return {
      root,
      target,
      versions,
      bin,
      run,
      cleanup: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(root, { recursive: true, force: true });
      },
    };
  }

  it.each(["empty", "foreign", "dangling", "valid"])(
    "preserves a late %s target at ln",
    async (kind) => {
      const f = await fixture();
      try {
        const result = await f.run(kind);
        expect(result.code === 0, result.output).toBe(kind === "valid");
        const before: { ino: number; children: string[] } = JSON.parse(
          await NodeFSP.readFile(NodePath.join(f.root, "collision.json"), "utf8"),
        );
        expect((await NodeFSP.lstat(f.target)).ino).toBe(before.ino);
        expect(await NodeFSP.readdir(f.versions)).toEqual([version]);
        if (kind === "dangling")
          expect(await NodeFSP.readlink(f.target)).toBe(NodePath.join(f.root, "missing"));
        else expect((await NodeFSP.readdir(f.target)).sort()).toEqual(before.children);
        expect(
          await NodeFSP.stat(NodePath.join(f.root, "foreign-executed")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        if (kind === "valid") {
          expect(
            NodeChildProcess.execFileSync(NodePath.join(f.bin, "t3"), ["--version"], {
              encoding: "utf8",
            }),
          ).toBe("winner --version\n");
        } else {
          expect(result.output).toContain("preserving runtime collision");
          expect(
            await NodeFSP.lstat(NodePath.join(f.bin, "t3")).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }
      } finally {
        await f.cleanup();
      }
    },
  );

  it.each(["absent", "signal", "parallel"])(
    "retains complete content with a relative home (%s)",
    async (kind) => {
      const f = await fixture();
      try {
        const results =
          kind === "parallel" ? await Promise.all([f.run(), f.run()]) : [await f.run(kind)];
        for (const result of results)
          expect(result.code, result.output).toBe(kind === "signal" ? 143 : 0);
        const content = await NodeFSP.readlink(f.target);
        expect(NodePath.isAbsolute(content)).toBe(true);
        expect(NodePath.basename(content)).toBe(version);
        expect(NodePath.basename(NodePath.dirname(content))).toMatch(/^\.content-/);
        expect(await NodeFSP.readdir(f.versions)).toHaveLength(2);
        expect(
          await NodeFSP.readFile(NodePath.join(content, "node_modules/native/payload"), "utf8"),
        ).toBe("native-content");
        expect(await NodeFSP.readFile(NodePath.join(content, ".install-complete"), "utf8")).toBe(
          `${version}\n`,
        );
        const restart = await f.run();
        expect(restart.code, restart.output).toBe(0);
        expect(
          NodeChildProcess.execFileSync(NodePath.join(f.bin, "t3"), ["__service-preflight"], {
            encoding: "utf8",
          }),
        ).toBe("fork __service-preflight\n");
      } finally {
        await f.cleanup();
      }
    },
  );
});
