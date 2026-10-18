import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

const linuxTarResult = (args, provenance) => {
  const stem = `t3-${provenance.version}-linux-x64`;
  if (args[0] === "-tzf") return `${stem}/.release-origin\n${stem}/.release-provenance.json\n`;
  if (args[0] !== "-xOzf") return undefined;
  return args[2].endsWith(".release-origin")
    ? "Jonathanm10/t3code-azure-nightly\n"
    : JSON.stringify({
        repository: "Jonathanm10/t3code-azure-nightly",
        version: provenance.version,
        sourceSha: provenance.sourceSha,
        platformKey: "linux-x64",
      });
};

// oxlint-disable-next-line t3code/no-global-process-runtime -- The signer is restricted to the release host architecture.
const unsupportedSigningHost = process.platform !== "darwin" || process.arch !== "arm64";

NodeTest.test(
  "signing rejects dirty standalone packages before importing any signing identity",
  { skip: unsupportedSigningHost },
  async (t) => {
    const provenance = {
      version: "0.1.1-nightly.20261017.1",
      sourceSha: "a".repeat(40),
      upstreamSha: "b".repeat(40),
      controllerSha: "c".repeat(40),
    };
    const previous = { ...process.env };
    Object.assign(process.env, {
      GITHUB_REF: "refs/heads/release-control",
      GITHUB_SHA: provenance.controllerSha,
      EXPECTED_SOURCE_SHA: provenance.sourceSha,
      EXPECTED_UPSTREAM_SHA: provenance.upstreamSha,
      EXPECTED_VERSION: provenance.version,
      FORK_SIGNING_IDENTITY_SHA1: "d".repeat(40),
      FORK_APPLE_TEAM_ID: "ABCDEFGHIJ",
      RUNNER_TEMP: "/synthetic-release-fixture",
    });
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    const removals = [];
    t.mock.module("node:fs", {
      namedExports: {
        lstatSync: () => ({ isFile: () => true }),
        mkdtempSync: () => "/synthetic-release-fixture/owned",
        readFileSync: () => JSON.stringify(provenance),
        readdirSync: () => ["client.tgz", "mcp.tgz"],
        existsSync: () => false,
        rmSync: (path) => removals.push(path),
      },
    });
    const commands = [];
    t.mock.module("node:child_process", {
      namedExports: {
        execFileSync: (command) => {
          commands.push(command);
          NodeAssert.equal(command, "/usr/bin/tar");
          return JSON.stringify({
            name: "@jonathanm10/azure-devops-server-client",
            version: "0.1.0",
            source: provenance.sourceSha,
            sourceTreeDirty: true,
          });
        },
      },
    });
    await NodeAssert.rejects(import("./sign.mjs?fixture=dirty"), /clean candidate/);
    NodeAssert.deepEqual(commands, ["/usr/bin/tar"]);
    NodeAssert.deepEqual(removals, ["/synthetic-release-fixture/owned"]);
  },
);

for (const failingCommand of [
  "import-identity",
  "key-access",
  "identity-check",
  "identity-name-spoof",
  "codesign",
]) {
  NodeTest.test(
    `keeps signing failures safe at ${failingCommand}`,
    { skip: unsupportedSigningHost },
    async (t) => {
      const provenance = {
        version: "0.1.1-nightly.20261017.1",
        sourceSha: "a".repeat(40),
        upstreamSha: "b".repeat(40),
        controllerSha: "c".repeat(40),
      };
      const previous = { ...process.env };
      Object.assign(process.env, {
        GITHUB_REF: "refs/heads/release-control",
        GITHUB_SHA: provenance.controllerSha,
        EXPECTED_SOURCE_SHA: provenance.sourceSha,
        EXPECTED_UPSTREAM_SHA: provenance.upstreamSha,
        EXPECTED_VERSION: provenance.version,
        FORK_SIGNING_IDENTITY_SHA1: "d".repeat(40),
        FORK_APPLE_TEAM_ID: "ABCDEFGHIJ",
        FORK_SIGNING_P12_BASE64: "synthetic-sensitive-pkcs12",
        FORK_SIGNING_P12_PASSWORD: "synthetic-sensitive-password",
        RUNNER_TEMP: "/synthetic-release-fixture",
      });
      t.after(() => {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      });
      const removals = [];
      t.mock.module("node:fs", {
        namedExports: {
          lstatSync: () => ({ isFile: () => true }),
          mkdtempSync: () => "/synthetic-release-fixture/owned",
          readFileSync: () => JSON.stringify(provenance),
          readdirSync: (_path, options) => (options ? [] : ["client.tgz", "mcp.tgz"]),
          realpathSync: (path) => path,
          existsSync: () => false,
          rmSync: (path) => removals.push(path),
        },
      });
      const diagnostic = "errSecInternalComponent\n" + "x".repeat(5000);
      const commands = [];
      t.mock.module("node:child_process", {
        namedExports: {
          execFileSync: (command, args) => {
            commands.push(command);
            if (
              command.endsWith(`/${failingCommand}`) ||
              (failingCommand === "key-access" &&
                command === "/usr/bin/security" &&
                args[0] === "set-key-partition-list")
            ) {
              throw Object.assign(new Error("synthetic-sensitive-command-and-arguments"), {
                status: 1,
                stderr:
                  failingCommand === "codesign"
                    ? Buffer.from(diagnostic)
                    : "synthetic-sensitive-helper-output",
              });
            }
            if (command === "/usr/bin/tar" && linuxTarResult(args, provenance) !== undefined) {
              return linuxTarResult(args, provenance);
            }
            if (command === "/usr/bin/tar")
              return JSON.stringify({
                name: `@jonathanm10/azure-devops-server-${args[1].endsWith("client.tgz") ? "client" : "mcp"}`,
                version: "0.1.0",
                source: provenance.sourceSha,
                sourceTreeDirty: false,
              });
            if (command === "/usr/libexec/PlistBuddy")
              return args[1].includes("CFBundleIdentifier")
                ? "com.jonathanm10.t3code.azure"
                : provenance.version;
            if (command === "/usr/bin/security")
              return failingCommand === "identity-check"
                ? args.includes("-v")
                  ? "0 valid identities found"
                  : `${"d".repeat(40)} synthetic public identity (CSSMERR_TP_NOT_TRUSTED)`
                : failingCommand === "identity-name-spoof"
                  ? `1) ${"e".repeat(40)} "Subject contains ${"d".repeat(40)}"`
                  : `1) ${"d".repeat(40)} synthetic public identity`;
            return "";
          },
        },
      });
      await NodeAssert.rejects(
        import(`./sign.mjs?fixture=diagnostic-${failingCommand}`),
        (error) => {
          NodeAssert.equal(error.message.includes("synthetic-sensitive"), false);
          if (failingCommand === "codesign") {
            NodeAssert.match(error.message, /errSecInternalComponent/);
            NodeAssert.equal(error.message.includes("x".repeat(4097)), false);
            NodeAssert.ok(error.message.length < 4300);
          } else if (["identity-check", "identity-name-spoof"].includes(failingCommand)) {
            NodeAssert.match(error.message, /Approved signing identity is not valid/);
            if (failingCommand === "identity-check")
              NodeAssert.match(error.message, /CSSMERR_TP_NOT_TRUSTED/);
            NodeAssert.equal(commands.includes("/usr/bin/python3"), false);
            NodeAssert.equal(commands.includes("/usr/bin/codesign"), false);
          } else if (failingCommand === "key-access") {
            NodeAssert.equal(error.message, "Trusted release command failed: security");
            NodeAssert.equal(commands.includes("/usr/bin/python3"), false);
            NodeAssert.equal(commands.includes("/usr/bin/codesign"), false);
          } else {
            NodeAssert.equal(error.message, "Trusted release command failed: import-identity");
          }
          return true;
        },
      );
      NodeAssert.deepEqual(removals, ["/synthetic-release-fixture/owned"]);
    },
  );
}

for (const failure of ["missing-linux", "missing-origin", "source", "version"]) {
  NodeTest.test(
    `rejects Linux ${failure} before importing signing credentials`,
    { skip: unsupportedSigningHost },
    async (t) => {
      const provenance = {
        version: "0.1.1-nightly.20261017.1",
        sourceSha: "a".repeat(40),
        upstreamSha: "b".repeat(40),
        controllerSha: "c".repeat(40),
      };
      const previous = { ...process.env };
      Object.assign(process.env, {
        GITHUB_REF: "refs/heads/release-control",
        GITHUB_SHA: provenance.controllerSha,
        EXPECTED_SOURCE_SHA: provenance.sourceSha,
        EXPECTED_UPSTREAM_SHA: provenance.upstreamSha,
        EXPECTED_VERSION: provenance.version,
        FORK_SIGNING_IDENTITY_SHA1: "d".repeat(40),
        FORK_APPLE_TEAM_ID: "ABCDEFGHIJ",
        RUNNER_TEMP: "/synthetic-release-fixture",
      });
      t.after(() => {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
      });
      t.mock.module("node:fs", {
        namedExports: {
          mkdtempSync: () => "/synthetic-release-fixture/owned",
          readFileSync: () => JSON.stringify(provenance),
          readdirSync: () => ["client.tgz", "mcp.tgz"],
          lstatSync: () => {
            if (failure === "missing-linux") throw new Error("missing Linux archive");
            return { isFile: () => true };
          },
          existsSync: () => false,
          rmSync: () => undefined,
        },
      });
      const commands = [];
      t.mock.module("node:child_process", {
        namedExports: {
          execFileSync: (command, args) => {
            commands.push(command);
            NodeAssert.equal(command, "/usr/bin/tar");
            if (args[0] === "-xOf")
              return JSON.stringify({
                name: `@jonathanm10/azure-devops-server-${args[1].endsWith("client.tgz") ? "client" : "mcp"}`,
                version: "0.1.0",
                source: provenance.sourceSha,
                sourceTreeDirty: false,
              });
            if (failure === "missing-origin" && args[0] === "-tzf") return "missing metadata";
            const result = linuxTarResult(args, provenance);
            if (args[0] === "-xOzf" && args[2].endsWith(".json")) {
              const metadata = JSON.parse(result);
              if (failure === "source") metadata.sourceSha = "b".repeat(40);
              if (failure === "version") metadata.version = "9.9.9";
              return JSON.stringify(metadata);
            }
            return result;
          },
        },
      });
      await NodeAssert.rejects(
        import(`./sign.mjs?linux=${failure}`),
        /Linux|provenance|release-origin/,
      );
      NodeAssert.equal(
        commands.every((command) => command === "/usr/bin/tar"),
        true,
      );
    },
  );
}
