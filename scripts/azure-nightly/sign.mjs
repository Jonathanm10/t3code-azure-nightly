import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";
import { sha256 } from "./release-policy.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- The trusted signing CLI validates its host before reading signing inputs.
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("Signing requires a dedicated macOS arm64 runner.");
if (process.env.GITHUB_REF !== "refs/heads/release-control")
  throw new Error("Signing requires the protected release-control branch.");
const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`Required signing reference is absent: ${name}`);
  return value;
};
const identity = required("FORK_SIGNING_IDENTITY_SHA1");
const team = required("FORK_APPLE_TEAM_ID");
if (!/^[A-Fa-f0-9]{40}$/.test(identity) || !/^[A-Z0-9]{10}$/.test(team))
  throw new Error("Invalid signing identity reference.");
const input = NodePath.resolve(process.argv[2] ?? "unsigned");
const output = NodePath.resolve(process.argv[3] ?? "signed");
const controller = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const temporary = NodeFS.mkdtempSync(NodePath.join(required("RUNNER_TEMP"), "azure-signing-"));
const keychain = NodePath.join(temporary, "signing.keychain-db");
const keychainPassword = NodeCrypto.randomBytes(32).toString("hex");
const childEnv = {
  PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  HOME: process.env.HOME,
  TMPDIR: temporary,
};
function run(command, args, options = {}) {
  try {
    return NodeChildProcess.execFileSync(command, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 30 * 60_000,
      ...options,
    });
  } catch {
    throw new Error(`Trusted release command failed: ${NodePath.basename(command)}`);
  }
}
const provenance = JSON.parse(
  NodeFS.readFileSync(NodePath.join(input, "azure-nightly-provenance.json"), "utf8"),
);
if (
  !/^\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(provenance.version) ||
  !/^[0-9a-f]{40}$/.test(provenance.sourceSha) ||
  provenance.controllerSha !== process.env.GITHUB_SHA
)
  throw new Error("Invalid candidate provenance.");
if (
  provenance.sourceSha !== required("EXPECTED_SOURCE_SHA") ||
  provenance.version !== required("EXPECTED_VERSION") ||
  provenance.upstreamSha !== required("EXPECTED_UPSTREAM_SHA")
)
  throw new Error("Candidate does not match integration outputs.");
const archive = NodePath.join(input, "unsigned-app.zip");
const app = NodePath.join(temporary, "app", "T3 Code (Azure Nightly).app");
const signingEntitlements = NodePath.join(controller, "entitlements.plist");
try {
  const helper = NodePath.join(temporary, "import-identity");
  run("/usr/bin/swiftc", [
    NodePath.join(controller, "import-signing-identity.swift"),
    "-o",
    helper,
  ]);
  const importPayload = JSON.stringify({
    pkcs12Base64: required("FORK_SIGNING_P12_BASE64"),
    importPassword: required("FORK_SIGNING_P12_PASSWORD"),
    keychainPassword,
  });
  run(helper, [keychain], { input: importPayload, stdio: ["pipe", "pipe", "pipe"] });
  for (const name of ["FORK_SIGNING_P12_BASE64", "FORK_SIGNING_P12_PASSWORD"])
    delete process.env[name];
  run("/usr/bin/python3", [
    NodePath.join(controller, "extract-app.py"),
    archive,
    NodePath.dirname(app),
  ]);
  const root = NodeFS.realpathSync(app);
  const targets = [];
  function walk(directory) {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const target = NodePath.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const real = NodeFS.realpathSync(target);
        if (real !== root && !real.startsWith(`${root}/`))
          throw new Error("Candidate contains an escaping symlink.");
      } else if (entry.isDirectory()) {
        walk(target);
        if (/\.(app|framework|xpc)$/.test(entry.name)) targets.push(target);
      } else if (entry.isFile() && run("/usr/bin/file", ["-b", target]).startsWith("Mach-O"))
        targets.push(target);
    }
  }
  const bundleId = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    NodePath.join(app, "Contents/Info.plist"),
  ]).trim();
  const version = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleShortVersionString",
    NodePath.join(app, "Contents/Info.plist"),
  ]).trim();
  if (bundleId !== "com.jonathanm10.t3code.azure" || version !== provenance.version)
    throw new Error("Candidate bundle identity/version does not match the release.");
  walk(app);
  targets.push(app);
  for (const target of targets)
    run("/usr/bin/codesign", [
      "--force",
      "--sign",
      identity,
      "--keychain",
      keychain,
      "--options",
      "runtime",
      "--timestamp",
      "--entitlements",
      signingEntitlements,
      target,
    ]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "-R",
    `=anchor apple generic and identifier "com.jonathanm10.t3code.azure" and certificate leaf[subject.OU] = "${team}"`,
    app,
  ]);
  const keyPath = NodePath.join(temporary, "notary.p8");
  NodeFS.writeFileSync(keyPath, Buffer.from(required("FORK_NOTARY_KEY_BASE64"), "base64"), {
    mode: 0o600,
  });
  delete process.env.FORK_NOTARY_KEY_BASE64;
  const notaryArgs = [
    "--key",
    keyPath,
    "--key-id",
    required("FORK_NOTARY_KEY_ID"),
    "--issuer",
    required("FORK_NOTARY_ISSUER"),
  ];
  const preStapleZip = NodePath.join(temporary, "notarize.zip");
  run("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, preStapleZip]);
  const notarization = JSON.parse(
    run("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      preStapleZip,
      ...notaryArgs,
      "--wait",
      "--output-format",
      "json",
    ]),
  );
  if (notarization.status !== "Accepted") throw new Error("Apple did not accept notarization.");
  run("/usr/bin/xcrun", ["stapler", "staple", app]);
  run("/usr/bin/xcrun", ["stapler", "validate", app]);
  run("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  NodeFS.mkdirSync(output, { recursive: true });
  const zipName = `T3-Code-Azure-${provenance.version}-arm64.zip`;
  const dmgName = `T3-Code-Azure-${provenance.version}-arm64.dmg`;
  run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    NodePath.join(output, zipName),
  ]);
  run("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-format",
    "UDZO",
    "-volname",
    "T3 Code Azure Nightly",
    "-srcfolder",
    NodePath.dirname(app),
    NodePath.join(output, dmgName),
  ]);
  run("/usr/bin/codesign", [
    "--sign",
    identity,
    "--keychain",
    keychain,
    "--timestamp",
    NodePath.join(output, dmgName),
  ]);
  const dmgNotary = JSON.parse(
    run("/usr/bin/xcrun", [
      "notarytool",
      "submit",
      NodePath.join(output, dmgName),
      ...notaryArgs,
      "--wait",
      "--output-format",
      "json",
    ]),
  );
  if (dmgNotary.status !== "Accepted") throw new Error("Apple did not accept DMG notarization.");
  run("/usr/bin/xcrun", ["stapler", "staple", NodePath.join(output, dmgName)]);
  run("/usr/bin/xcrun", ["stapler", "validate", NodePath.join(output, dmgName)]);
  const packageProvenance = [];
  for (const name of NodeFS.readdirSync(input).filter((name) => name.endsWith(".tgz"))) {
    const archivePath = NodePath.join(input, name);
    const metadata = JSON.parse(
      run("/usr/bin/tar", ["-xOf", archivePath, "package/provenance.json"]),
    );
    if (
      !/^@jonathanm10\/azure-devops-server-(client|mcp)$/.test(metadata.name) ||
      metadata.source !== provenance.sourceSha ||
      !/^\d+\.\d+\.\d+$/.test(metadata.version)
    )
      throw new Error("Standalone package provenance does not match the candidate.");
    packageProvenance.push(metadata);
    NodeFS.copyFileSync(archivePath, NodePath.join(output, name));
  }
  if (
    new Set(packageProvenance.map((entry) => entry.name)).size !== 2 ||
    packageProvenance.length !== 2
  )
    throw new Error("Both standalone core and MCP packages are required.");
  const zip = NodeFS.readFileSync(NodePath.join(output, zipName));
  NodeFS.writeFileSync(
    NodePath.join(output, "nightly-mac.yml"),
    `version: ${provenance.version}\nfiles:\n  - url: ${zipName}\n    sha512: ${NodeCrypto.createHash("sha512").update(zip).digest("base64")}\n    size: ${zip.length}\npath: ${zipName}\nsha512: ${NodeCrypto.createHash("sha512").update(zip).digest("base64")}\nreleaseDate: '${new Date().toISOString()}'\n`,
  );
  const assets = NodeFS.readdirSync(output)
    .sort()
    .map((name) => {
      const bytes = NodeFS.readFileSync(NodePath.join(output, name));
      return { name, size: bytes.length, sha256: sha256(bytes) };
    });
  NodeFS.writeFileSync(
    NodePath.join(output, "release-manifest.json"),
    JSON.stringify(
      {
        ...provenance,
        signingIdentitySha1: identity,
        teamId: team,
        notarizationId: notarization.id,
        packages: packageProvenance,
        assets,
      },
      null,
      2,
    ),
  );
} finally {
  try {
    if (NodeFS.existsSync(keychain)) run("/usr/bin/security", ["delete-keychain", keychain]);
  } finally {
    NodeFS.rmSync(temporary, { recursive: true, force: true });
  }
}
