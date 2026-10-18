import { expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  update: vi.fn(async () => ({ status: "updated" })),
  providers: vi.fn(async () => []),
  version: "0.1.1-nightly.20261018.2",
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [{ status: "idle" }] }));
vi.mock("~/branding", () => ({ APP_VERSION: "0.1.1-nightly.20261018.1" }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/connection/desktopLocal", () => ({ isDesktopLocalConnectionTarget: () => false }));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "fedora",
        label: "fedora",
        connection: { phase: "connected" },
        entry: { target: { _tag: "RemoteConnectionTarget" } },
        serverConfig: {
          environment: {
            serverVersion: "0.1.1-nightly.20261018.1",
            capabilities: { serverSelfUpdate: "boot-service" },
          },
          settings: { continueThreadsAfterServerUpdate: false },
        },
      },
    ],
  }),
}));
vi.mock("~/state/environmentAtomList", () => ({ environmentIdsKey: () => "fedora" }));
vi.mock("~/state/server", () => ({ environmentUpdateStatesAtom: () => undefined }));
vi.mock("~/state/session", () => ({ environmentSessionStatesAtom: () => undefined }));
vi.mock("../ProviderUpdatesAction", () => ({
  useProviderUpdates: () => ({ machines: [], updateAll: fixture.providers }),
}));
vi.mock("../ServerUpdateAction", () => ({
  canUpdateServer: () => true,
  useServerUpdate: () => fixture.update,
}));
vi.mock("./updateEverythingRun", () => ({
  clearSavedUpdateEverythingResult: vi.fn(),
  saveUpdateEverythingResult: vi.fn(),
  setUpdateEverythingRun: vi.fn(),
  settleUpdateRunMachine: vi.fn(),
  showUpdateEverythingResult: vi.fn(),
  waitForServerUpdateHandoff: (_id: string, operation: Promise<unknown>) => operation,
  waitForUpdateRestart: async () => true,
}));

import { useUpdateEverything } from "./useUpdateEverything";

it("updates Fedora to the exact pending Mac fork version without consulting a registry or browser feed", async () => {
  const fetch = vi.fn(() => Promise.reject(new Error("No browser release lookup is needed")));
  vi.stubGlobal("fetch", fetch);
  try {
    const update = useUpdateEverything(fixture.version);
    expect(update.hasUpdates).toBe(true);
    expect(update.skipped).toEqual([]);
    await update.run({});
    expect(fixture.update).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: "fedora",
        selfUpdate: "boot-service",
        targetVersion: fixture.version,
      }),
      { quiet: true },
    );
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
