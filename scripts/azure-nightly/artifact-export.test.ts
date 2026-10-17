import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  copyDesktopArtifacts,
  DesktopBuildNoArtifactsProducedError,
} from "../build-desktop-artifact.ts";

it.effect("exports the actual fork ZIP and its feed metadata", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "azure-artifact-export-" });
    const stageDistDir = path.join(root, "stage");
    const outputDir = path.join(root, "out");
    yield* fs.makeDirectory(stageDistDir);
    const archive = "T3-Code-Azure-0.1.1-nightly.20261017.1-arm64.zip";
    yield* fs.writeFileString(path.join(stageDistDir, archive), "actual ZIP bytes");
    yield* fs.writeFileString(path.join(stageDistDir, "nightly-mac.yml"), "feed");
    yield* copyDesktopArtifacts({ stageDistDir, outputDir, platform: "mac", arch: "arm64" });
    assert.equal(yield* fs.readFileString(path.join(outputDir, archive)), "actual ZIP bytes");
    assert.equal(yield* fs.readFileString(path.join(outputDir, "nightly-mac.yml")), "feed");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("fails if a builder emits only a debug YAML file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "azure-artifact-export-" });
    const stageDistDir = path.join(root, "stage");
    yield* fs.makeDirectory(stageDistDir);
    yield* fs.writeFileString(path.join(stageDistDir, "builder-debug.yml"), "debug");
    const failure = yield* copyDesktopArtifacts({
      stageDistDir,
      outputDir: path.join(root, "out"),
      platform: "mac",
      arch: "arm64",
    }).pipe(Effect.flip);
    assert.instanceOf(failure, DesktopBuildNoArtifactsProducedError);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
