import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopUserData from "./DesktopUserData.ts";

const resolveWindowsUserData = (appDataDirectory: string) =>
  DesktopUserData.resolveUserDataPath({
    appDataDirectory,
    isDevelopment: false,
    platform: "win32",
  }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer));

it.layer(NodeServices.layer)("DesktopPreReadyFileSystem", (it) => {
  it.effect("keeps official Windows credential state outside the fork", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pre-ready-fs-" });
      yield* fileSystem.makeDirectory(path.join(root, "T3 Code (Alpha)"));
      yield* fileSystem.writeFileString(path.join(root, "T3 Code (Alpha)", "Local State"), "keys");

      const userData = yield* resolveWindowsUserData(root);

      assert.equal(userData, path.join(root, "t3code-azure-nightly"));
      assert.isFalse(yield* fileSystem.exists(path.join(userData, "Local State")));
    }),
  );

  it.effect("preserves synchronous filesystem read failures", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const exit = yield* Effect.exit(fs.readFileString("/nonexistent-t3-fork-fixture/file"));
      assert.isTrue(Exit.isFailure(exit));
    }).pipe(Effect.provide(DesktopPreReadyFileSystem.layer)),
  );
});
