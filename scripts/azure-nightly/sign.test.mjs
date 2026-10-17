import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

NodeTest.test(
  "signing rejects dirty standalone packages before importing any signing identity",
  // oxlint-disable-next-line t3code/no-global-process-runtime -- The signer only runs on the release host architecture.
  { skip: process.platform !== "darwin" || process.arch !== "arm64" },
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
