// @effect-diagnostics nodeBuiltinImport:off - This boundary runs synchronously before Electron loads Clerk or native storage.
import * as NodeFS from "node:fs";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import { assertReviewedDesktopElectronVersion } from "../../../../scripts/lib/desktop-electron-version.ts";

export const FORK_ID = "com.jonathanm10.t3code.azure";
export const FORK_NAME = "T3 Code (Azure Nightly)";
export const FORK_ELECTRON_NAME = "T3 Code Azure Nightly";
export const FORK_SCHEME = "t3code-azure";
export const RESERVED_PROFILE_DIRECTORY = ".t3-desktop-isolated";

const ProfileBinding = Schema.Struct({
  version: Schema.Literal(1),
  profileId: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,47}$/)),
  bundleId: Schema.Literal(FORK_ID),
  appName: Schema.Literal(`${FORK_NAME}.app`),
});
const decodeBinding = Schema.decodeUnknownSync(Schema.fromJsonString(ProfileBinding));

export interface DesktopForkProfile {
  readonly kind: "normal" | "isolated";
  readonly root: string;
  readonly electronName: string;
  readonly userData: string;
  readonly sessionData: string;
  readonly clerkStorage: string;
  readonly backendHome: string;
  readonly logs: string;
  readonly crashDumps: string;
  readonly updateCache: string;
  readonly compileCache: string;
}

const assertRealPath = (target: string): void => {
  if (NodeFS.realpathSync(target) !== target) {
    throw new Error(`Fork profile path must not contain symlinks: ${target}`);
  }
};

export function resolveDesktopForkProfile(input: {
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly isDevelopment: boolean;
  readonly developmentHome?: string | undefined;
}): DesktopForkProfile {
  const executable = NodePath.resolve(input.executablePath);
  const segments = executable.split(NodePath.sep);
  const reservedIndex = segments.indexOf(RESERVED_PROFILE_DIRECTORY);
  let kind: DesktopForkProfile["kind"] = "normal";
  let root = NodePath.join(
    input.homeDirectory,
    ".t3-azure-nightly",
    input.isDevelopment ? "dev" : "default",
  );
  let electronName = `${FORK_ELECTRON_NAME}${input.isDevelopment ? " Dev" : ""}`;
  if (reservedIndex !== -1) {
    if (segments.lastIndexOf(RESERVED_PROFILE_DIRECTORY) !== reservedIndex) {
      throw new Error("Ambiguous reserved fork profile layout.");
    }
    const profileId = segments[reservedIndex + 1];
    root = segments.slice(0, reservedIndex + 2).join(NodePath.sep);
    const expectedApp = NodePath.join(root, "Applications", `${FORK_NAME}.app`);
    if (
      !executable.startsWith(
        `${expectedApp}${NodePath.sep}Contents${NodePath.sep}MacOS${NodePath.sep}`,
      )
    ) {
      throw new Error("Reserved fork profile executable is outside its bound application.");
    }
    assertRealPath(executable);
    assertRealPath(root);
    const descriptor = NodePath.join(root, "profile.json");
    assertRealPath(descriptor);
    if (NodeFS.statSync(descriptor).size > 4096)
      throw new Error("Fork profile binding is too large.");
    const binding = decodeBinding(NodeFS.readFileSync(descriptor, "utf8"));
    if (binding.profileId !== profileId)
      throw new Error("Fork profile binding does not match its installation.");
    const infoPlist = NodePath.join(expectedApp, "Contents", "Info.plist");
    assertRealPath(infoPlist);
    const plist = NodeFS.readFileSync(infoPlist, "utf8");
    const bundleId = plist.startsWith("bplist")
      ? NodeChildProcess.execFileSync(
          "/usr/bin/plutil",
          ["-extract", "CFBundleIdentifier", "raw", "-o", "-", infoPlist],
          { encoding: "utf8", timeout: 1000, maxBuffer: 4096 },
        ).trim()
      : /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    if (bundleId !== FORK_ID) {
      throw new Error("Reserved fork profile has a different bundle identity.");
    }
    kind = "isolated";
    electronName = `${FORK_ELECTRON_NAME} Proof ${binding.profileId}`;
  }
  const dataRoot = kind === "isolated" ? NodePath.join(root, "data") : root;
  const developmentHome =
    input.isDevelopment && kind === "normal" ? input.developmentHome?.trim() : undefined;
  const backendHome = developmentHome
    ? NodePath.resolve(developmentHome)
    : NodePath.join(dataRoot, "backend");
  if (developmentHome) {
    const officialHome = NodePath.join(input.homeDirectory, ".t3");
    const officialDataDirectories = [
      NodePath.join(officialHome, "userdata"),
      NodePath.join(officialHome, "dev"),
      ...[
        NodePath.join(input.homeDirectory, "Library", "Application Support"),
        NodePath.join(input.homeDirectory, "AppData", "Roaming"),
        NodePath.join(input.homeDirectory, ".config"),
      ].flatMap((appData) =>
        ["t3code-v2", "t3code-dev", "t3code", "T3 Code (Alpha)", "T3 Code (Dev)"].map((name) =>
          NodePath.join(appData, name),
        ),
      ),
    ];
    if (
      backendHome === officialHome ||
      officialDataDirectories.some(
        (directory) =>
          backendHome === directory || backendHome.startsWith(`${directory}${NodePath.sep}`),
      )
    ) {
      throw new Error("Development home must not use an official T3 profile.");
    }
  }
  const paths = {
    userData: NodePath.join(dataRoot, "electron", "userData"),
    sessionData: NodePath.join(dataRoot, "electron", "sessionData"),
    clerkStorage: NodePath.join(backendHome, "userdata"),
    backendHome,
    logs: NodePath.join(dataRoot, "logs"),
    crashDumps: NodePath.join(dataRoot, "crashes"),
    updateCache: NodePath.join(dataRoot, "updates"),
    compileCache: NodePath.join(dataRoot, "compile-cache"),
  };
  for (const target of Object.values(paths)) {
    let ancestor = target;
    while (!NodeFS.existsSync(ancestor)) ancestor = NodePath.dirname(ancestor);
    assertRealPath(ancestor);
  }
  for (const target of Object.values(paths)) {
    NodeFS.mkdirSync(target, { recursive: true, mode: 0o700 });
    assertRealPath(target);
  }
  return { kind, root, electronName, ...paths };
}

export function initializeDesktopForkProfile(input: {
  readonly executablePath: string;
  readonly homeDirectory: string;
  readonly isDevelopment: boolean;
  readonly electronVersion: string | undefined;
  readonly appVersion: string;
  readonly pid: number;
  readonly env: NodeJS.ProcessEnv;
  readonly app: {
    setName(name: string): void;
    setPath(name: "userData" | "sessionData" | "logs" | "crashDumps", target: string): void;
    setAsDefaultProtocolClient: (protocol: string, executable?: string, args?: string[]) => boolean;
  };
}) {
  assertReviewedDesktopElectronVersion(input.electronVersion);
  const profile = resolveDesktopForkProfile({ ...input, developmentHome: input.env.T3CODE_HOME });
  input.app.setName(profile.electronName);
  input.app.setPath("userData", profile.userData);
  input.app.setPath("sessionData", profile.sessionData);
  input.app.setPath("logs", profile.logs);
  input.app.setPath("crashDumps", profile.crashDumps);
  input.env.T3CODE_HOME = profile.backendHome;
  input.env.T3CODE_FORK_USER_DATA = profile.userData;
  input.env.T3CODE_FORK_SESSION_DATA = profile.sessionData;
  input.env.T3CODE_FORK_ELECTRON_NAME = profile.electronName;
  input.env.T3CODE_FORK_UPDATE_CACHE = profile.updateCache;
  input.env.T3CODE_FORK_COMPILE_CACHE = profile.compileCache;
  input.env.T3CODE_FORK_ISOLATED = profile.kind === "isolated" ? "1" : "0";
  NodeFS.writeFileSync(
    NodePath.join(profile.backendHome, "desktop-profile.json"),
    JSON.stringify({
      ...profile,
      pid: input.pid,
      executablePath: input.executablePath,
      appVersion: input.appVersion,
      electronVersion: input.electronVersion,
      safeStorageService: `${profile.electronName} Safe Storage`,
      safeStorageAccount: profile.electronName,
    }),
    { mode: 0o600 },
  );
  if (profile.kind === "isolated") input.app.setAsDefaultProtocolClient = () => false;
  return profile;
}
