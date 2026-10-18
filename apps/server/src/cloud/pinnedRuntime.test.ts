// @effect-diagnostics nodeBuiltinImport:off - Checks the inode at the exact publication boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProcessRunner from "../processRunner.ts";
import {
  ensurePinnedRuntimeInstalled,
  pinnedRuntimeCommand,
  pinnedRuntimePaths,
  PinnedRuntimeInstallError,
  type PinnedRuntimeProgress,
} from "./pinnedRuntime.ts";

const version = "1.2.3";
const archiveName = `t3-${version}-linux-x64.tar.gz`;
const archiveBytes = new TextEncoder().encode("not really a tarball");
const archiveHex = (bytes: Uint8Array) =>
  Effect.promise(() => crypto.subtle.digest("SHA-256", bytes)).pipe(
    Effect.map((digest) =>
      Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );
const validChecksums = archiveHex(archiveBytes).pipe(
  Effect.map((hex) => `${hex}  ${archiveName}\n`),
);
const releaseHttpClient = (checksums: string, requests: string[] = []) =>
  HttpClient.make((request) => {
    requests.push(request.url);
    const body = request.url.endsWith("/SHA256SUMS") ? checksums : archiveBytes;
    return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
  });
const extractingRunner = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  commands: string[] = [],
  metadata: {
    readonly origin: string | undefined;
    readonly version?: string;
    readonly platformKey?: string;
    readonly sourceSha?: string;
  } = { origin: CLI_RELEASE_REPOSITORY },
) =>
  ProcessRunner.ProcessRunner.of({
    run: (input) =>
      Effect.gen(function* () {
        commands.push(input.command);
        const targetIndex = input.args.indexOf("-C");
        const stagingDir = input.args[targetIndex + 1];
        if (input.command !== "tar" || stagingDir === undefined) {
          return yield* Effect.die(`unexpected command ${input.command}`);
        }
        yield* fs.writeFileString(path.join(stagingDir, "t3"), "#!/bin/sh\n").pipe(Effect.orDie);
        if (metadata.origin !== undefined) {
          yield* fs
            .writeFileString(path.join(stagingDir, ".release-origin"), `${metadata.origin}\n`)
            .pipe(Effect.orDie);
        }
        yield* fs
          .writeFileString(
            path.join(stagingDir, ".release-provenance.json"),
            JSON.stringify({
              repository: CLI_RELEASE_REPOSITORY,
              version: metadata.version ?? version,
              sourceSha: metadata.sourceSha ?? "a".repeat(40),
              platformKey: metadata.platformKey ?? "linux-x64",
            }),
          )
          .pipe(Effect.orDie);
        return {
          stdout: "",
          stderr: "",
          code: ChildProcessSpawner.ExitCode(0),
          timedOut: false,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        };
      }),
  });

it.layer(NodeServices.layer)("ensurePinnedRuntimeInstalled", (it) => {
  it.effect("installs the verified release archive as the runtime executable", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-" });
      const requests: string[] = [];
      const commands: string[] = [];
      const paths = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        releaseBaseUrl: "https://releases.example/download",
        runner: extractingRunner(fs, path, commands),
        validate: (staging) =>
          fs.exists(staging.entryPath).pipe(
            Effect.flatMap((exists) => (exists ? Effect.void : Effect.die("missing runtime"))),
            Effect.orDie,
          ),
      });
      assert.equal(paths.entryPath, path.join(paths.versionDir, "t3"));
      assert.deepEqual(pinnedRuntimeCommand(paths), { command: paths.entryPath, args: [] });
      assert.deepEqual(requests, [
        `https://releases.example/download/v${version}/SHA256SUMS`,
        `https://releases.example/download/v${version}/${archiveName}`,
      ]);
      assert.deepEqual(commands, ["tar"]);
      assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      assert.isFalse(yield* fs.exists(path.join(paths.versionDir, "t3-runtime-archive")));
      const content = yield* fs.readLink(paths.versionDir);
      assert.equal(path.basename(content), version);
      assert.equal(path.dirname(path.dirname(content)), path.dirname(paths.versionDir));
      assert.equal(yield* fs.readFileString(path.join(content, "t3")), "#!/bin/sh\n");
    }),
  );

  it.effect.each([true, false])(
    "reports bytes before completion, then verifies and extracts (known size: %s)",
    (knownSize) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-" });
        const firstChunk = yield* Deferred.make<void>();
        let archiveController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const checksums = yield* validChecksums;
        const progress: PinnedRuntimeProgress[] = [];
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.endsWith("/SHA256SUMS")
                ? new Response(checksums)
                : new Response(
                    new ReadableStream({
                      start(controller) {
                        archiveController = controller;
                        controller.enqueue(archiveBytes.slice(0, 4));
                      },
                    }),
                    { headers: knownSize ? { "content-length": String(archiveBytes.length) } : {} },
                  ),
            ),
          ),
        );
        const install = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: client,
          runner: extractingRunner(fs, path),
          validate: () => Effect.void,
          onProgress: (event) => {
            progress.push(event);
            if (event.stage === "download" && event.received === 4) {
              Deferred.doneUnsafe(firstChunk, Effect.void);
            }
          },
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(firstChunk);
        assert.deepEqual(progress.at(-1), {
          stage: "download",
          received: 4,
          total: knownSize ? archiveBytes.length : undefined,
        });
        assert.isFalse(progress.some((event) => event.stage === "extract"));
        assert.isDefined(archiveController);
        archiveController!.enqueue(archiveBytes.slice(4));
        archiveController!.close();
        const installed = yield* Fiber.join(install);
        assert.deepEqual(progress.slice(-4), [
          { stage: "download", received: archiveBytes.length, total: archiveBytes.length },
          { stage: "verify" },
          { stage: "extract" },
          { stage: "validate" },
        ]);
        assert.equal(yield* fs.readFileString(installed.sentinelPath), `${version}\n`);
      }),
  );

  it.effect("cleans up an interrupted download without reporting verification or extraction", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-progress-failed-" });
      const checksums = yield* validChecksums;
      const progress: PinnedRuntimeProgress[] = [];
      let cancelled = false;
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/SHA256SUMS")
              ? new Response(checksums)
              : new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(archiveBytes.slice(0, 4));
                    },
                    cancel() {
                      cancelled = true;
                    },
                  }),
                ),
          ),
        ),
      );
      const firstChunk = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: client,
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not validate an interrupted archive"),
        onProgress: (event) => {
          progress.push(event);
          if (event.stage === "download" && event.received === 4)
            Deferred.doneUnsafe(firstChunk, Effect.void);
        },
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(firstChunk);
      yield* Fiber.interrupt(install);
      assert.deepEqual(progress.at(-1), { stage: "download", received: 4, total: undefined });
      assert.isTrue(progress.every((event) => event.stage === "download"));
      assert.isTrue(cancelled);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("refuses an archive whose checksum does not match the release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-archive-bad-" });
      const commands: string[] = [];
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(`${"0".repeat(64)}  ${archiveName}\n`),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.die("must not validate an unverified archive"),
      }).pipe(Effect.flip);
      assert.instanceOf(error, PinnedRuntimeInstallError);
      assert.equal(error.step, "verifying the t3 release archive checksum");
      assert.deepEqual(commands, []);
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime", "versions")), []);
    }),
  );

  it.effect("validates a staging tree before atomically publishing it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      let validatedDirectory = "";

      const installed = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: (staging) =>
          Effect.gen(function* () {
            validatedDirectory = staging.versionDir;
            assert.isFalse(yield* fs.exists(finalPaths.versionDir));
            assert.isTrue(yield* fs.exists(staging.entryPath));
          }).pipe(Effect.orDie),
      });

      assert.notEqual(validatedDirectory, finalPaths.versionDir);
      assert.deepEqual(installed, finalPaths);
      assert.isTrue(yield* fs.exists(finalPaths.entryPath));
      assert.equal(yield* fs.readFileString(finalPaths.sentinelPath), `${version}\n`);
    }),
  );

  it.effect("removes staging and leaves no final runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-test-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");

      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () =>
          Effect.fail(new PinnedRuntimeInstallError({ step: "validating the staged runtime" })),
      }).pipe(Effect.flip);

      assert.isFalse(yield* fs.exists(finalPaths.versionDir));
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(finalPaths.versionDir))).filter((entry) =>
          entry.startsWith(".staging-"),
        ),
        [],
      );
    }),
  );

  it.effect("preserves an empty unmarked version directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-empty-collision-" });
      const paths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(paths.versionDir, { recursive: true });
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(""),
        runner: extractingRunner(fs, path),
        validate: () => Effect.die("must not execute a colliding runtime"),
      }).pipe(Effect.flip);
      assert.include(error.message, "preserving runtime collision");
      assert.isTrue(yield* fs.exists(paths.versionDir));
      assert.deepEqual(yield* fs.readDirectory(paths.versionDir), []);
    }),
  );

  it.effect.each([undefined, "pingdotgg/t3code", CLI_RELEASE_REPOSITORY])(
    "preserves an incomplete pre-existing runtime collision (origin %s)",
    (origin) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-collision-" });
        const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
        yield* fs.makeDirectory(finalPaths.versionDir, { recursive: true });
        yield* fs.writeFileString(path.join(finalPaths.versionDir, "partial"), "incomplete\n");
        if (origin !== undefined)
          yield* fs.writeFileString(path.join(finalPaths.versionDir, ".release-origin"), origin);
        const requests: string[] = [];
        const error = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums, requests),
          runner: extractingRunner(fs, path),
          validate: () => Effect.die("must not execute a colliding runtime"),
        }).pipe(Effect.flip);
        assert.include(error.message, "preserving runtime collision");
        assert.equal(
          yield* fs.readFileString(path.join(finalPaths.versionDir, "partial")),
          "incomplete\n",
        );
        assert.deepEqual(requests, []);
      }),
  );

  it.effect.each([undefined, "pingdotgg/t3code"])(
    "refuses a completed cached official or unmarked runtime without invoking validation (%s)",
    (origin) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-cached-origin-" });
        const paths = pinnedRuntimePaths(path, baseDir, version, "linux");
        yield* fs.makeDirectory(paths.versionDir, { recursive: true });
        yield* fs.writeFileString(paths.entryPath, "official executable");
        yield* fs.writeFileString(paths.sentinelPath, `${version}\n`);
        if (origin !== undefined)
          yield* fs.writeFileString(path.join(paths.versionDir, ".release-origin"), origin);
        const error = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(""),
          runner: extractingRunner(fs, path),
          validate: () => Effect.die("must not execute cached official runtime"),
        }).pipe(Effect.flip);
        assert.include(error.message, "preserving runtime collision");
        assert.equal(yield* fs.readFileString(paths.entryPath), "official executable");
        assert.equal(yield* fs.readFileString(paths.sentinelPath), `${version}\n`);
      }),
  );

  it.effect.each([
    { origin: undefined },
    { origin: "pingdotgg/t3code" },
    { origin: CLI_RELEASE_REPOSITORY, version: "9.9.9" },
    { origin: CLI_RELEASE_REPOSITORY, platformKey: "darwin-arm64" },
    { origin: CLI_RELEASE_REPOSITORY, sourceSha: "not-a-commit" },
  ])("rejects downloaded metadata before any runtime validation (%s)", (metadata) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-origin-" });
      const error = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path, [], metadata),
        validate: () => Effect.die("must not execute a foreign or mismatched staged runtime"),
      }).pipe(Effect.flip);
      assert.include(error.message, "origin and provenance");
      assert.deepEqual(yield* fs.readDirectory(path.join(baseDir, "runtime/versions")), []);
    }),
  );

  it.effect.each([undefined, "pingdotgg/t3code", CLI_RELEASE_REPOSITORY])(
    "checks a concurrent winner using the same completed-release predicate (origin %s)",
    (origin) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-winner-" });
        const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
        let validations = 0;
        const result = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums),
          runner: extractingRunner(fs, path),
          validate: (candidate) =>
            Effect.gen(function* () {
              validations++;
              if (candidate.versionDir === finalPaths.versionDir) return;
              yield* fs.makeDirectory(finalPaths.versionDir);
              yield* fs.writeFileString(finalPaths.entryPath, "concurrent winner");
              yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);
              yield* fs.writeFileString(
                path.join(finalPaths.versionDir, ".release-provenance.json"),
                JSON.stringify({
                  repository: CLI_RELEASE_REPOSITORY,
                  version,
                  sourceSha: "a".repeat(40),
                  platformKey: "linux-x64",
                }),
              );
              if (origin !== undefined)
                yield* fs.writeFileString(
                  path.join(finalPaths.versionDir, ".release-origin"),
                  origin,
                );
            }).pipe(Effect.orDie),
        }).pipe(Effect.result);
        assert.equal(Result.isSuccess(result), origin === CLI_RELEASE_REPOSITORY);
        assert.equal(validations, origin === CLI_RELEASE_REPOSITORY ? 2 : 1);
        assert.equal(yield* fs.readFileString(finalPaths.entryPath), "concurrent winner");
        assert.deepEqual(yield* fs.readDirectory(path.dirname(finalPaths.versionDir)), [version]);
      }),
  );

  it.effect.each(["empty", "foreign", "dangling", "valid"])(
    "preserves a target created at the publication syscall (%s)",
    (kind) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-late-" });
        const final = pinnedRuntimePaths(path, baseDir, version, "linux");
        let inode: number | undefined;
        let children: string[] = [];
        const collide = Effect.gen(function* () {
          if (kind === "dangling") {
            yield* fs.symlink(path.join(baseDir, "missing"), final.versionDir);
          } else {
            yield* fs.makeDirectory(final.versionDir);
            if (kind !== "empty") {
              yield* fs.writeFileString(final.entryPath, "concurrent executable");
              yield* fs.writeFileString(final.sentinelPath, `${version}\n`);
              yield* fs.writeFileString(
                path.join(final.versionDir, ".release-origin"),
                kind === "valid" ? CLI_RELEASE_REPOSITORY : "pingdotgg/t3code",
              );
              yield* fs.writeFileString(
                path.join(final.versionDir, ".release-provenance.json"),
                JSON.stringify({
                  repository: CLI_RELEASE_REPOSITORY,
                  version,
                  sourceSha: "a".repeat(40),
                  platformKey: "linux-x64",
                }),
              );
            }
            children = yield* fs.readDirectory(final.versionDir);
          }
          inode = (yield* Effect.promise(() => NodeFSP.lstat(final.versionDir))).ino;
        });
        const racingFs: FileSystem.FileSystem = {
          ...fs,
          symlink: (from, to) => collide.pipe(Effect.andThen(fs.symlink(from, to))),
          rename: (from, to) => collide.pipe(Effect.andThen(fs.rename(from, to))),
        };
        const validated: string[] = [];
        const result = yield* ensurePinnedRuntimeInstalled({
          baseDir,
          version,
          fs: racingFs,
          path,
          platform: "linux",
          arch: "x64",
          httpClient: releaseHttpClient(yield* validChecksums),
          runner: extractingRunner(fs, path),
          validate: (candidate) =>
            Effect.sync(() => {
              validated.push(candidate.versionDir);
            }),
        }).pipe(Effect.result);
        assert.equal(Result.isSuccess(result), kind === "valid");
        assert.isDefined(inode);
        assert.equal((yield* Effect.promise(() => NodeFSP.lstat(final.versionDir))).ino, inode);
        assert.equal(validated.includes(final.versionDir), kind === "valid");
        assert.deepEqual(yield* fs.readDirectory(path.dirname(final.versionDir)), [version]);
        if (kind === "dangling") {
          assert.equal(yield* fs.readLink(final.versionDir), path.join(baseDir, "missing"));
        } else {
          assert.deepEqual(yield* fs.readDirectory(final.versionDir), children);
          if (kind === "empty") assert.isFalse(yield* fs.exists(final.sentinelPath));
          else assert.equal(yield* fs.readFileString(final.entryPath), "concurrent executable");
        }
      }),
  );

  it.effect("retains complete content when interrupted immediately after symlink creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-published-" });
      const published = yield* Deferred.make<void>();
      const releasePublication = yield* Deferred.make<void>();
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs: {
          ...fs,
          symlink: (from, to) =>
            fs
              .symlink(from, to)
              .pipe(
                Effect.andThen(Deferred.succeed(published, undefined)),
                Effect.andThen(Deferred.await(releasePublication)),
              ),
        },
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path),
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(published);
      yield* Effect.sync(() => install.interruptUnsafe());
      yield* Deferred.succeed(releasePublication, undefined);
      yield* Fiber.interrupt(install);
      const final = pinnedRuntimePaths(path, baseDir, version, "linux");
      const content = yield* fs.readLink(final.versionDir);
      assert.equal(path.basename(content), version);
      assert.equal(path.dirname(path.dirname(content)), path.dirname(final.versionDir));
      assert.equal(yield* fs.readFileString(final.sentinelPath), `${version}\n`);
      const reused = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(""),
        runner: extractingRunner(fs, path),
        validate: (candidate) =>
          fs.readFileString(candidate.entryPath).pipe(
            Effect.map((source) => assert.equal(source, "#!/bin/sh\n")),
            Effect.orDie,
          ),
      });
      assert.deepEqual(reused, final);
    }),
  );

  it.effect("reuses the complete publication for two simultaneous installs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-parallel-" });
      const commands: string[] = [];
      const install = ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner: extractingRunner(fs, path, commands),
        validate: () => Effect.void,
      });
      const [one, two] = yield* Effect.all([install, install], { concurrency: "unbounded" });
      assert.deepEqual(one, two);
      assert.deepEqual(commands, ["tar"]);
      const content = yield* fs.readLink(one.versionDir);
      assert.equal(
        yield* fs.readFileString(path.join(content, ".install-complete")),
        `${version}\n`,
      );
      assert.deepEqual(
        (yield* fs.readDirectory(path.dirname(one.versionDir))).sort(),
        [path.basename(path.dirname(content)), version].sort(),
      );
    }),
  );

  it.effect("preserves a completed runtime when validation fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-repair-" });
      const finalPaths = pinnedRuntimePaths(path, baseDir, version, "linux");
      yield* fs.makeDirectory(path.dirname(finalPaths.entryPath), { recursive: true });
      yield* fs.writeFileString(finalPaths.entryPath, "broken\n");
      yield* fs.writeFileString(
        path.join(finalPaths.versionDir, ".release-origin"),
        CLI_RELEASE_REPOSITORY,
      );
      yield* fs.writeFileString(
        path.join(finalPaths.versionDir, ".release-provenance.json"),
        JSON.stringify({
          repository: CLI_RELEASE_REPOSITORY,
          version,
          sourceSha: "a".repeat(40),
          platformKey: "linux-x64",
        }),
      );
      yield* fs.writeFileString(finalPaths.sentinelPath, `${version}\n`);

      let validations = 0;
      const requests: string[] = [];
      yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums, requests),
        runner: extractingRunner(fs, path),
        validate: (paths) =>
          Effect.gen(function* () {
            validations += 1;
            const source = yield* fs.readFileString(paths.entryPath).pipe(Effect.orDie);
            if (source === "broken\n") {
              return yield* new PinnedRuntimeInstallError({ step: "validating the runtime" });
            }
          }),
      }).pipe(Effect.flip);

      assert.equal(validations, 1);
      assert.deepEqual(requests, []);
      assert.equal(yield* fs.readFileString(finalPaths.entryPath), "broken\n");
    }),
  );

  it.effect("removes staging when installation is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pinned-runtime-interrupt-" });
      const started = yield* Deferred.make<void>();
      const runner = ProcessRunner.ProcessRunner.of({
        run: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const install = yield* ensurePinnedRuntimeInstalled({
        baseDir,
        version,
        fs,
        path,
        platform: "linux",
        arch: "x64",
        httpClient: releaseHttpClient(yield* validChecksums),
        runner,
        validate: () => Effect.void,
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(started);
      yield* Fiber.interrupt(install);
      const versionsDir = path.join(baseDir, "runtime", "versions");
      assert.deepEqual(yield* fs.readDirectory(versionsDir), []);
    }),
  );
});
