// @effect-diagnostics nodeBuiltinImport:off - Exercises the real synchronous pre-ready filesystem boundary in disposable fixtures.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import {
  FORK_ID,
  FORK_NAME,
  resolveDesktopForkProfile,
  initializeDesktopForkProfile,
} from "./DesktopForkProfile.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const homeDirectory = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-profile-")),
  );
  roots.push(homeDirectory);
  const root = NodePath.join(homeDirectory, ".t3-desktop-isolated", "update-proof");
  const app = NodePath.join(root, "Applications", `${FORK_NAME}.app`);
  const executablePath = NodePath.join(app, "Contents", "MacOS", FORK_NAME);
  NodeFS.mkdirSync(NodePath.dirname(executablePath), { recursive: true });
  NodeFS.writeFileSync(executablePath, "fixture");
  NodeFS.writeFileSync(
    NodePath.join(app, "Contents", "Info.plist"),
    `<plist><dict><key>CFBundleIdentifier</key><string>${FORK_ID}</string></dict></plist>`,
  );
  NodeFS.writeFileSync(
    NodePath.join(root, "profile.json"),
    JSON.stringify({
      version: 1,
      profileId: "update-proof",
      bundleId: FORK_ID,
      appName: `${FORK_NAME}.app`,
    }),
  );
  return { homeDirectory, root, app, executablePath, isDevelopment: false };
}

it("resolves the same persistent proof profile after replacing the app without launch state", () => {
  const input = fixture();
  const a = resolveDesktopForkProfile(input);
  NodeFS.writeFileSync(input.executablePath, "replacement B");
  const b = resolveDesktopForkProfile({
    executablePath: input.executablePath,
    homeDirectory: input.homeDirectory,
    isDevelopment: false,
  });
  expect(b).toEqual(a);
  expect(a.kind).toBe("isolated");
  expect(a.electronName).toBe("T3 Code Azure Nightly Proof update-proof");
  for (const target of [
    a.userData,
    a.sessionData,
    a.clerkStorage,
    a.backendHome,
    a.logs,
    a.updateCache,
    a.compileCache,
  ])
    expect(target.startsWith(`${input.root}/data/`)).toBe(true);
});

it("fails closed for missing, malformed and mismatched reserved bindings", () => {
  const input = fixture();
  const descriptor = NodePath.join(input.root, "profile.json");
  for (const value of [
    "{}",
    "not-json",
    JSON.stringify({
      version: 1,
      profileId: "other",
      bundleId: FORK_ID,
      appName: `${FORK_NAME}.app`,
    }),
  ]) {
    NodeFS.writeFileSync(descriptor, value);
    expect(() => resolveDesktopForkProfile(input)).toThrow();
  }
  NodeFS.rmSync(descriptor);
  expect(() => resolveDesktopForkProfile(input)).toThrow();
});

it("rejects an escaping data symlink before writing through it", () => {
  const input = fixture();
  const outside = NodePath.join(input.homeDirectory, "outside");
  NodeFS.mkdirSync(outside);
  NodeFS.symlinkSync(outside, NodePath.join(input.root, "data"));
  expect(() => resolveDesktopForkProfile(input)).toThrow("symlinks");
  expect(NodeFS.readdirSync(outside)).toEqual([]);
});

it("uses a separate normal fork identity without importing official data", () => {
  const input = fixture();
  const profile = resolveDesktopForkProfile({
    ...input,
    executablePath:
      "/Applications/T3 Code (Azure Nightly).app/Contents/MacOS/T3 Code (Azure Nightly)",
  });
  expect(profile.root).toBe(NodePath.join(input.homeDirectory, ".t3-azure-nightly", "default"));
  expect(profile.userData).not.toContain("t3code-v2");
  expect(profile.backendHome).not.toBe(NodePath.join(input.homeDirectory, ".t3"));
  expect(profile.electronName).toBe("T3 Code Azure Nightly");
});

it("binds native storage and Clerk inputs synchronously before allowing application startup", () => {
  const input = fixture();
  const events: string[] = [];
  const env = { T3CODE_HOME: "/official-ambient-home" };
  const app = {
    setName: (name: string) => {
      events.push(`name:${name}`);
    },
    setPath: (name: string, target: string) => {
      events.push(`${name}:${target}`);
    },
    setAsDefaultProtocolClient: () => true,
  };
  const profile = initializeDesktopForkProfile({
    ...input,
    env,
    app,
    electronVersion: "44.4.5",
    appVersion: "0.1.1-nightly.20261017.1",
    pid: 123,
  });
  expect(events[0]).toBe(`name:${profile.electronName}`);
  expect(events.slice(1)).toEqual([
    `userData:${profile.userData}`,
    `sessionData:${profile.sessionData}`,
    `logs:${profile.logs}`,
    `crashDumps:${profile.crashDumps}`,
  ]);
  expect(env.T3CODE_HOME).toBe(profile.backendHome);
  expect(app.setAsDefaultProtocolClient()).toBe(false);
  const diagnostic = JSON.parse(
    NodeFS.readFileSync(NodePath.join(profile.backendHome, "desktop-profile.json"), "utf8"),
  );
  expect(diagnostic.safeStorageService).toBe(`${profile.electronName} Safe Storage`);
  expect(() =>
    initializeDesktopForkProfile({
      ...input,
      env,
      app,
      electronVersion: "45.0.0",
      appVersion: "test",
      pid: 123,
    }),
  ).toThrow("reviewed Electron");
});

// oxlint-disable-next-line t3code/no-global-process-runtime -- This disposable fixture invokes the macOS plist tool only.
it.skipIf(process.platform !== "darwin")(
  "validates a binary Info.plist without changing signed application bytes",
  () => {
    const input = fixture();
    const infoPlist = NodePath.join(input.app, "Contents", "Info.plist");
    NodeChildProcess.execFileSync("/usr/bin/plutil", ["-convert", "binary1", infoPlist]);
    const before = NodeFS.readFileSync(infoPlist);
    expect(resolveDesktopForkProfile(input).kind).toBe("isolated");
    expect(NodeFS.readFileSync(infoPlist)).toEqual(before);
  },
);
