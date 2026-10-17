import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { afterAll, afterEach, beforeEach, vi } from "vite-plus/test";

const { autoUpdaterMock } = vi.hoisted(() => ({
  autoUpdaterMock: {
    allowDowngrade: false,
    allowPrerelease: false,
    autoDownload: true,
    autoInstallOnAppQuit: true,
    channel: "latest",
    disableDifferentialDownload: false,
    fullChangelog: false,
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    downloadUpdate: vi.fn(() => Promise.resolve([])),
    on: vi.fn(),
    quitAndInstall: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
  },
}));

const { electronMock, macUpdaters, requestError, restoreElectron, tempDir } = await vi.hoisted(
  async () => {
    const NodeModule = await import("node:module");
    const NodeEvents = await import("node:events");
    const NodeFs = await import("node:fs");
    const NodeOs = await import("node:os");
    const NodePath = await import("node:path");
    const tempDir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "t3-updater-executor-"));
    const requestError = new Error("Electron request boundary reached");
    const electronMock = {
      app: {
        getVersion: () => "1.0.0-nightly.1",
        getName: () => "T3 updater test",
        getPath: vi.fn(() => NodePath.join(tempDir, "userData")),
        isPackaged: true,
        whenReady: () => Promise.resolve(),
      },
      autoUpdater: new NodeEvents.EventEmitter(),
      net: {
        request: vi.fn((_options: Electron.ClientRequestConstructorOptions) => {
          const request = new NodeEvents.EventEmitter();
          return Object.assign(request, {
            end: () => {
              request.emit("login", { isProxy: true }, () => {});
              request.emit("error", requestError);
            },
            abort: () => {},
          });
        }),
      },
      session: { fromPartition: vi.fn(() => ({ partition: "electron-updater" })) },
    };
    // electron-updater requires Electron through CommonJS, outside Vitest's ESM mocks.
    const require = NodeModule.createRequire(import.meta.url);
    const electronPath = require.resolve("electron");
    const previousElectron = require.cache[electronPath];
    const electronModule = new NodeModule.Module(electronPath);
    electronModule.exports = electronMock;
    require.cache[electronPath] = electronModule;

    return {
      electronMock,
      macUpdaters: new Array<
        import("electron-updater").MacUpdater & {
          readonly cachePath: string;
          readonly profilePath: string;
        }
      >(),
      requestError,
      tempDir,
      restoreElectron: () => {
        if (previousElectron) require.cache[electronPath] = previousElectron;
        else delete require.cache[electronPath];
        NodeFs.rmSync(tempDir, { recursive: true, force: true });
      },
    };
  },
);

vi.mock("electron-updater", async (importOriginal) => {
  const actual = await importOriginal<typeof import("electron-updater")>();
  return {
    autoUpdater: autoUpdaterMock,
    MacUpdater: class extends actual.MacUpdater {
      constructor(...args: ConstructorParameters<typeof actual.MacUpdater>) {
        super(...args);
        this.logger = null;
        macUpdaters.push(this);
      }

      get cachePath() {
        return this.app.baseCachePath;
      }

      get profilePath() {
        return this.app.userDataPath;
      }
    },
  };
});

import * as ElectronUpdater from "./ElectronUpdater.ts";

describe("ElectronUpdater", () => {
  afterAll(restoreElectron);
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(() => {
    autoUpdaterMock.allowDowngrade = false;
    autoUpdaterMock.allowPrerelease = false;
    autoUpdaterMock.autoDownload = true;
    autoUpdaterMock.autoInstallOnAppQuit = true;
    autoUpdaterMock.channel = "latest";
    autoUpdaterMock.disableDifferentialDownload = false;
    autoUpdaterMock.fullChangelog = false;
    autoUpdaterMock.checkForUpdates.mockClear();
    autoUpdaterMock.checkForUpdates.mockImplementation(() => Promise.resolve(null));
    autoUpdaterMock.downloadUpdate.mockClear();
    autoUpdaterMock.downloadUpdate.mockImplementation(() => Promise.resolve([]));
    autoUpdaterMock.on.mockClear();
    autoUpdaterMock.quitAndInstall.mockClear();
    autoUpdaterMock.removeListener.mockClear();
    autoUpdaterMock.setFeedURL.mockClear();
  });

  it.effect("scopes updater event listeners", () =>
    Effect.gen(function* () {
      const listener = vi.fn();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updater = yield* ElectronUpdater.ElectronUpdater;
          yield* updater.on("update-available", listener);
        }),
      );

      assert.deepEqual(autoUpdaterMock.on.mock.calls, [["update-available", listener]]);
      assert.deepEqual(autoUpdaterMock.removeListener.mock.calls, [["update-available", listener]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("wraps rejected update checks in the method-specific typed error", () =>
    Effect.gen(function* () {
      const cause = new Error("network unavailable");
      autoUpdaterMock.checkForUpdates.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "beta";

      const error = yield* updater.checkForUpdates.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterCheckForUpdatesError);
      assert.equal(error.channel, "beta");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, "Electron updater failed to check for updates on channel beta.");
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("preserves the execution-time channel on download failures", () =>
    Effect.gen(function* () {
      const cause = new Error("download unavailable");
      autoUpdaterMock.downloadUpdate.mockImplementationOnce(() => Promise.reject(cause));
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "nightly";

      const error = yield* updater.downloadUpdate.pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterDownloadUpdateError);
      assert.equal(error.channel, "nightly");
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to download the update on channel nightly.",
      );
      assert.notInclude(error.message, cause.message);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("sets full changelog mode", () =>
    Effect.gen(function* () {
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setFullChangelog(true);
      assert.equal(autoUpdaterMock.fullChangelog, true);

      yield* updater.setFullChangelog(false);
      assert.equal(autoUpdaterMock.fullChangelog, false);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );

  it.effect("uses the injected Linux platform when the fork update cache is set", () =>
    Effect.gen(function* () {
      vi.stubEnv("T3CODE_FORK_UPDATE_CACHE", "/tmp/t3-azure-updater-test-cache");
      const updater = yield* ElectronUpdater.ElectronUpdater;

      yield* updater.setAutoDownload(false);

      assert.equal(autoUpdaterMock.autoDownload, false);
    }).pipe(
      Effect.provide(ElectronUpdater.layer),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
  );

  it.effect("keeps native requests and proxy login with isolated macOS profile caches", () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const profile of ["profile-a", "profile-b"]) {
          vi.resetModules();
          electronMock.net.request.mockClear();
          const cachePath = `${tempDir}/${profile}/update-cache`;
          const profilePath = `${tempDir}/${profile}/userData`;
          vi.stubEnv("T3CODE_FORK_UPDATE_CACHE", cachePath);
          electronMock.app.getPath.mockReturnValue(profilePath);
          const freshModule = yield* Effect.promise(() => import("./ElectronUpdater.ts"));
          const updater = yield* freshModule.make;
          const login = vi.fn();
          yield* updater.on("login", login);
          yield* updater.setChannel("nightly");
          yield* updater.setFeedURL({ provider: "github", owner: "test", repo: "updater" });

          const error = yield* updater.checkForUpdates.pipe(Effect.flip);

          assert.strictEqual(error.cause, requestError);
          assert.equal(error.channel, "nightly");
          assert.equal(electronMock.net.request.mock.calls.length, 1);
          assert.equal(electronMock.net.request.mock.calls[0]?.[0].hostname, "github.com");
          assert.equal(
            electronMock.net.request.mock.calls[0]?.[0].path,
            "/test/updater/releases.atom",
          );
          assert.equal(login.mock.calls.length, 1);
          assert.deepEqual(login.mock.calls[0]?.[0], { isProxy: true });
          assert.equal(macUpdaters.at(-1)?.cachePath, cachePath);
          assert.equal(macUpdaters.at(-1)?.profilePath, profilePath);
        }
        assert.equal(macUpdaters.length, 2);
      }),
    ).pipe(Effect.provideService(HostProcess.Platform, "darwin")),
  );

  it.effect("preserves quit-and-install flags and the execution-time channel", () =>
    Effect.gen(function* () {
      const cause = new Error("quit and install failed");
      autoUpdaterMock.quitAndInstall.mockImplementationOnce(() => {
        throw cause;
      });
      const updater = yield* ElectronUpdater.ElectronUpdater;
      autoUpdaterMock.channel = "alpha";

      const error = yield* updater
        .quitAndInstall({ isSilent: true, isForceRunAfter: false })
        .pipe(Effect.flip);

      assert.instanceOf(error, ElectronUpdater.ElectronUpdaterQuitAndInstallError);
      assert.equal(error.channel, "alpha");
      assert.equal(error.isSilent, true);
      assert.equal(error.isForceRunAfter, false);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        "Electron updater failed to quit and install the update on channel alpha (silent: true, force run after: false).",
      );
      assert.notInclude(error.message, cause.message);
      assert.deepEqual(autoUpdaterMock.quitAndInstall.mock.calls, [[true, false]]);
    }).pipe(Effect.provide(ElectronUpdater.layer)),
  );
});
