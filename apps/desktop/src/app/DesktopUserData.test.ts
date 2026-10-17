import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodePath from "@effect/platform-node/NodePath";
import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "win32", "linux"] as const)(
  "never migrates official credential material on %s",
  (platform) =>
    Effect.gen(function* () {
      const actual = yield* resolveUserDataPath({
        appDataDirectory: "/profiles",
        isDevelopment: false,
        platform,
      });
      assert.equal(actual, "/profiles/t3code-azure-nightly");
    }).pipe(Effect.provide(NodePath.layerPosix)),
);
it.effect("uses the synchronously bound isolated profile", () =>
  Effect.gen(function* () {
    const actual = yield* resolveUserDataPath({
      appDataDirectory: "/profiles",
      userDataDirectory: "/proof/data/electron/userData",
      isDevelopment: false,
      platform: "darwin",
    });
    assert.equal(actual, "/proof/data/electron/userData");
  }).pipe(Effect.provide(NodePath.layerPosix)),
);
