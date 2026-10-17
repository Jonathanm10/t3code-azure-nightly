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

it("retains explicit and worktree development homes in the backend and Clerk stores", () => {
  const input = fixture();
  for (const developmentHome of [
    NodePath.join(input.homeDirectory, "explicit-sandbox"),
    NodePath.join(input.homeDirectory, ".t3", "worktrees", "first", ".t3"),
    NodePath.join(input.homeDirectory, ".t3", "worktrees", "second", ".t3"),
  ]) {
    const env = { T3CODE_HOME: developmentHome };
    const profile = initializeDesktopForkProfile({
      ...input,
      executablePath: "/development/Electron",
      isDevelopment: true,
      env,
      app: { setName() {}, setPath() {}, setAsDefaultProtocolClient: () => true },
      electronVersion: "44.4.5",
      appVersion: "test",
      pid: 123,
    });
    expect(env.T3CODE_HOME).toBe(developmentHome);
    expect(profile.backendHome).toBe(developmentHome);
    expect(profile.clerkStorage).toBe(NodePath.join(developmentHome, "userdata"));
  }
});

it("rejects official development targets and aliases before creating profile files", () => {
  const input = fixture();
  const official = NodePath.join(input.homeDirectory, ".t3", "userdata");
  NodeFS.mkdirSync(official, { recursive: true });
  const alias = NodePath.join(input.homeDirectory, "alias");
  NodeFS.symlinkSync(official, alias);
  for (const developmentHome of [
    NodePath.join(input.homeDirectory, ".t3"),
    official,
    NodePath.join(official, "nested"),
    NodePath.join(input.homeDirectory, "Library", "Application Support", "t3code-v2"),
    NodePath.join(input.homeDirectory, "Library", "Application Support", "T3 Code (Dev)"),
    alias,
  ]) {
    expect(() =>
      initializeDesktopForkProfile({
        ...input,
        executablePath: "/development/Electron",
        isDevelopment: true,
        env: { T3CODE_HOME: developmentHome },
        app: { setName() {}, setPath() {}, setAsDefaultProtocolClient: () => true },
        electronVersion: "44.4.5",
        appVersion: "test",
        pid: 123,
      }),
    ).toThrow();
    expect(NodeFS.readdirSync(official)).toEqual([]);
    expect(NodeFS.existsSync(NodePath.join(input.homeDirectory, ".t3-azure-nightly"))).toBe(false);
  }
});

it("ignores the ambient official home in a normal packaged launch", () => {
  const input = fixture();
  const env = { T3CODE_HOME: NodePath.join(input.homeDirectory, ".t3") };
  const profile = initializeDesktopForkProfile({
    ...input,
    executablePath: "/Applications/T3 Code (Azure Nightly).app/Contents/MacOS/Electron",
    env,
    app: { setName() {}, setPath() {}, setAsDefaultProtocolClient: () => true },
    electronVersion: "44.4.5",
    appVersion: "test",
    pid: 123,
  });
  expect(env.T3CODE_HOME).toBe(profile.backendHome);
  expect(profile.backendHome).toBe(
    NodePath.join(input.homeDirectory, ".t3-azure-nightly", "default", "backend"),
  );
  expect(NodeFS.existsSync(NodePath.join(input.homeDirectory, ".t3"))).toBe(false);
});

it("rejects an unreviewed Electron before creating data or changing application state", () => {
  const input = fixture();
  const env = { T3CODE_HOME: NodePath.join(input.homeDirectory, "sandbox") };
  const touched: string[] = [];
  expect(() =>
    initializeDesktopForkProfile({
      ...input,
      executablePath: "/development/Electron",
      isDevelopment: true,
      electronVersion: "44.4.6",
      env,
      app: {
        setName: (name) => {
          touched.push(name);
        },
        setPath: (name) => {
          touched.push(name);
        },
        setAsDefaultProtocolClient: () => true,
      },
      appVersion: "test",
      pid: 123,
    }),
  ).toThrow("reviewed Electron");
  expect(touched).toEqual([]);
  expect(env.T3CODE_HOME).toBe(NodePath.join(input.homeDirectory, "sandbox"));
  expect(NodeFS.existsSync(NodePath.join(input.homeDirectory, "sandbox"))).toBe(false);
  expect(NodeFS.existsSync(NodePath.join(input.homeDirectory, ".t3-azure-nightly"))).toBe(false);
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
