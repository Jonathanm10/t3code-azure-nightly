// @effect-diagnostics nodeBuiltinImport:off - Serves a fake GitHub Release over real HTTP to the published launcher.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { buildNpmLauncher } from "./build-npm-launcher.ts";

const VERSION = "1.2.3";
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const run = Effect.fn("test.run")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(command, args, { cwd: options.cwd, env: options.env, extendEnv: false }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
}, Effect.scoped);

/** A release archive for this host with a stub `t3` that echoes its args and launcher. */
const serveFakeRelease = Effect.fn("test.serveFakeRelease")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const key = `${yield* HostProcess.Platform}-${yield* HostProcess.Architecture}`;
  const stem = `t3-${VERSION}-${key}`;
  const archiveName = `${stem}.tar.gz`;
  yield* fs.makeDirectory(path.join(root, "release", stem, "node_modules/native"), {
    recursive: true,
  });
  yield* fs.writeFileString(
    path.join(root, "release", stem, "node_modules/native/payload"),
    "native-content",
  );
  yield* fs.writeFileString(
    path.join(root, "release", stem, "t3"),
    '#!/bin/sh\necho "stub $* launcher=$T3CODE_NPM_LAUNCHER_PATH"\nexit 7\n',
  );
  yield* fs.chmod(path.join(root, "release", stem, "t3"), 0o755);
  yield* fs.writeFileString(
    path.join(root, "release", stem, ".release-origin"),
    `${CLI_RELEASE_REPOSITORY}\n`,
  );
  yield* fs.writeFileString(
    path.join(root, "release", stem, ".release-provenance.json"),
    JSON.stringify({
      repository: CLI_RELEASE_REPOSITORY,
      version: VERSION,
      sourceSha: "a".repeat(40),
      platformKey: key,
    }),
  );
  const tar = yield* run("tar", ["-czf", archiveName, stem], {
    cwd: path.join(root, "release"),
    env: { PATH: process.env.PATH },
  });
  assert.equal(tar.exitCode, 0, tar.stderr);
  const archive = yield* fs.readFile(path.join(root, "release", archiveName));
  let checksum = NodeCrypto.createHash("sha256").update(archive).digest("hex");
  const requests: Array<string> = [];
  const server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === `/v${VERSION}/SHA256SUMS`) {
      response.end(`${checksum}  ${archiveName}\n`);
    } else if (request.url === `/v${VERSION}/${archiveName}`) {
      response.writeHead(200, { "Content-Length": archive.length }).end(archive);
    } else {
      response.writeHead(404).end();
    }
  });
  yield* Effect.acquireRelease(
    Effect.callback<void>((resume) => {
      server.listen(0, "127.0.0.1", () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") return yield* Effect.die("no TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    corruptChecksum: () => {
      checksum = "0".repeat(64);
    },
  };
});

it.layer(NodeServices.layer)("build-npm-launcher", (it) => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "publishes a launcher that downloads, verifies, caches, and runs the release executable",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-npm-launcher-test-" })
          .pipe(Effect.flatMap(fs.realPath));
        const output = yield* buildNpmLauncher({
          version: VERSION,
          outputDir: path.join(root, "out"),
        });

        const manifest = yield* decodeManifest(
          yield* fs.readFileString(path.join(output.packageDir, "package.json")),
        );
        assert.equal(manifest.name, "t3");
        assert.equal(manifest.version, VERSION);
        assert.deepStrictEqual(manifest.bin, { t3: "./bin/t3.mjs" });
        // Nothing for npm to resolve, so nothing that can lag behind the launcher.
        assert.isUndefined(manifest.dependencies);
        assert.isUndefined(manifest.optionalDependencies);

        // Run what npm would install: the published tarball, unpacked.
        const installed = path.join(root, "installed");
        yield* fs.makeDirectory(installed);
        const unpack = yield* run("tar", ["-xzf", output.tarball, "-C", installed], {
          cwd: root,
          env: { PATH: process.env.PATH },
        });
        assert.equal(unpack.exitCode, 0, unpack.stderr);
        const packageDir = path.join(installed, "package");

        const release = yield* serveFakeRelease(root);
        const home = path.join(root, "home");
        const env = {
          PATH: process.env.PATH,
          T3CODE_HOME: path.relative(root, home),
          T3CODE_RELEASE_BASE_URL: release.baseUrl,
        };
        const launcher = yield* fs.realPath(path.join(packageDir, "bin/t3.mjs"));
        const first = yield* run(process.execPath, [launcher, "serve", "a b"], {
          cwd: root,
          env,
        });
        assert.equal(first.stdout.trim(), `stub serve a b launcher=${launcher}`, first.stderr);
        assert.equal(first.exitCode, 7);
        // The same layout the install scripts and `t3 update` use.
        const versionDir = path.join(home, "runtime/versions", VERSION);
        assert.equal(
          (yield* fs.readFileString(path.join(versionDir, ".install-complete"))).trim(),
          VERSION,
        );
        assert.isTrue(yield* fs.exists(path.join(versionDir, "node_modules/native")));
        const content = yield* fs.readLink(versionDir);
        assert.isTrue(path.isAbsolute(content));
        assert.equal(path.basename(content), VERSION);
        assert.match(path.basename(path.dirname(content)), /^\.content-/);
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(home, "runtime/versions"))).sort(),
          [path.basename(path.dirname(content)), VERSION].sort(),
        );

        // A second run reuses the download.
        const requestsAfterFirst = release.requests.length;
        const second = yield* run(process.execPath, [launcher, "--version"], { cwd: root, env });
        assert.equal(second.exitCode, 7);
        assert.equal(release.requests.length, requestsAfterFirst);

        // Services installed before 0.0.41 fork dist/bin.mjs and talk to the
        // server over IPC; the channel and SIGTERM must reach the executable.
        const ipcServer = path.join(home, "runtime/versions", VERSION, "t3");
        yield* fs.writeFileString(
          ipcServer,
          `#!${process.execPath}\nprocess.on("SIGTERM", () => process.exit(23));\nprocess.on("message", (m) => process.send({ reply: m }));\nprocess.send({ args: process.argv.slice(2) });\n`,
        );
        const legacy = NodeChildProcess.fork(
          path.join(packageDir, "dist/bin.mjs"),
          ["__service-preflight", "a b"],
          { cwd: root, env, silent: true },
        );
        yield* Effect.promise(async () => {
          assert.deepStrictEqual((await NodeEvents.EventEmitter.once(legacy, "message"))[0], {
            args: ["__service-preflight", "a b"],
          });
          const reply = NodeEvents.EventEmitter.once(legacy, "message");
          legacy.send({ type: "trial-accepted" });
          assert.deepStrictEqual((await reply)[0], { reply: { type: "trial-accepted" } });
          const exit = NodeEvents.EventEmitter.once(legacy, "exit");
          legacy.kill("SIGTERM");
          assert.deepStrictEqual(await exit, [23, null]);
        });

        const collisionHome = path.join(root, "collision-home");
        const collisionDir = path.join(collisionHome, "runtime/versions", VERSION);
        yield* fs.makeDirectory(collisionDir, { recursive: true });
        yield* fs.writeFileString(path.join(collisionDir, "partial"), "preserve me");
        const collision = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: collisionHome },
        });
        assert.equal(collision.exitCode, 1);
        assert.include(collision.stderr, "preserving runtime collision");
        assert.equal(yield* fs.readFileString(path.join(collisionDir, "partial")), "preserve me");
        assert.equal(release.requests.length, requestsAfterFirst);

        for (const kind of ["empty", "foreign", "dangling", "valid", "published-error"]) {
          const lateHome = path.join(root, `late-${kind}`);
          const target = path.join(lateHome, "runtime/versions", VERSION);
          const preload = path.join(root, `inject-${kind}.mjs`);
          yield* fs.writeFileString(
            preload,
            `
import fs from "node:fs";
import path from "node:path";
const target = ${JSON.stringify(target)}, kind = ${JSON.stringify(kind)};
const symlink = fs.symlinkSync;
for (const method of ["symlinkSync", "renameSync"]) {
  const publish = fs[method];
  fs[method] = function (from, to, ...args) {
    if (to !== target) return publish.call(fs, from, to, ...args);
    if (kind === "published-error") {
      publish.call(fs, from, to, ...args);
      throw new Error("interrupted after publication");
    }
    if (kind === "dangling") symlink(path.join(target, "..", "missing"), target);
    else if (kind === "empty") fs.mkdirSync(target);
    else {
      fs.cpSync(from, target, { recursive: true });
      if (kind === "foreign") {
        fs.writeFileSync(path.join(target, ".release-origin"), "pingdotgg/t3code");
        fs.writeFileSync(path.join(target, "t3"), '#!/bin/sh\\necho FOREIGN-EXECUTED\\n');
      }
    }
    fs.writeFileSync(target + ".inode", String(fs.lstatSync(target).ino));
    fs.writeFileSync(target + ".children", kind === "dangling" ? "" : fs.readdirSync(target).sort().join("\\n"));
    return publish.call(fs, from, to, ...args);
  };
}
`,
          );
          const late = yield* run(process.execPath, ["--import", preload, launcher, "--version"], {
            cwd: root,
            env: { ...env, T3CODE_HOME: path.relative(root, lateHome) },
          });
          const accepted = kind === "valid" || kind === "published-error";
          assert.equal(late.exitCode, accepted ? 7 : 1, late.stderr);
          assert.notInclude(late.stdout, "FOREIGN-EXECUTED");
          if (kind === "published-error") {
            const retained = yield* fs.readLink(target);
            assert.equal(
              yield* fs.readFileString(path.join(retained, "node_modules/native/payload")),
              "native-content",
            );
            assert.equal(
              yield* fs.readFileString(path.join(retained, ".install-complete")),
              `${VERSION}\n`,
            );
          } else {
            assert.equal(
              NodeFS.lstatSync(target).ino,
              Number(yield* fs.readFileString(`${target}.inode`)),
            );
            if (kind === "dangling")
              assert.equal(yield* fs.readLink(target), path.join(path.dirname(target), "missing"));
            else
              assert.equal(
                (yield* fs.readDirectory(target)).sort().join("\n"),
                yield* fs.readFileString(`${target}.children`),
              );
            yield* fs.remove(`${target}.inode`);
            yield* fs.remove(`${target}.children`);
            assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(target)), [VERSION]);
          }
          if (accepted) {
            const restart = yield* run(process.execPath, [launcher, "__service-preflight"], {
              cwd: root,
              env: { ...env, T3CODE_HOME: path.relative(root, lateHome) },
            });
            assert.equal(restart.exitCode, 7, restart.stderr);
            assert.include(restart.stdout, "stub __service-preflight");
          } else assert.include(late.stderr, "preserving runtime collision");
        }

        // Two first runs at once both start, and neither removes the other's install.
        const raceHome = path.join(root, "race-home");
        const launch = run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: raceHome },
        });
        const [one, two] = yield* Effect.all([launch, launch], { concurrency: "unbounded" });
        assert.equal(one.exitCode, 7, one.stderr);
        assert.equal(two.exitCode, 7, two.stderr);
        const raceContent = yield* fs.readLink(path.join(raceHome, "runtime/versions", VERSION));
        assert.deepStrictEqual(
          (yield* fs.readDirectory(path.join(raceHome, "runtime/versions"))).sort(),
          [path.basename(path.dirname(raceContent)), VERSION].sort(),
        );
        assert.isTrue(yield* fs.exists(path.join(raceContent, "node_modules/native")));

        // A download that does not match the release checksums is never installed.
        release.corruptChecksum();
        const corrupt = yield* run(process.execPath, [launcher, "--version"], {
          cwd: root,
          env: { ...env, T3CODE_HOME: path.join(root, "other-home") },
        });
        assert.equal(corrupt.exitCode, 1);
        assert.include(corrupt.stderr, "checksum mismatch");
        assert.deepStrictEqual(
          yield* fs.readDirectory(path.join(root, "other-home/runtime/versions")),
          [],
        );
      }),
  );
});
