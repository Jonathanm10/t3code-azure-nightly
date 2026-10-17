import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

NodeTest.test(
  "integration versions follow the concrete Nightly tag instead of placeholder manifests",
  async (t) => {
    const sourceSha = "a".repeat(40);
    const upstreamSha = "b".repeat(40);
    const writes = new Map();
    t.mock.module("node:fs", {
      namedExports: {
        readFileSync: () => JSON.stringify({ version: "0.1.0" }),
        writeFileSync: (path, contents) => writes.set(path, contents),
        appendFileSync: () => {},
      },
    });
    t.mock.module("node:child_process", {
      namedExports: {
        execFileSync: (command, args) => {
          NodeAssert.equal(command, "git");
          return args.includes("FETCH_HEAD^{commit}") ? upstreamSha : sourceSha;
        },
      },
    });
    const previous = { ...process.env };
    Object.assign(process.env, {
      GITHUB_REF: "refs/heads/release-control",
      GITHUB_REPOSITORY: "fixture/fork",
      GITHUB_SHA: "c".repeat(40),
      GH_TOKEN: "fixture-token",
      GITHUB_EVENT_NAME: "workflow_dispatch",
    });
    t.after(() => {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    });
    t.mock.method(globalThis, "fetch", async (input) => {
      const url = new URL(input);
      NodeAssert.equal(url.hostname, "api.github.com");
      return Response.json(
        url.pathname === "/repos/t3tools/t3code/releases"
          ? [{ id: 1, tag_name: "v0.1.1-nightly.20261017.9000", draft: false, prerelease: true }]
          : [],
      );
    });
    await import("./integrate.mjs?fixture=upstream-tag");
    const provenance = JSON.parse([...writes.values()][0]);
    NodeAssert.match(provenance.version, /^0\.1\.1-nightly\.\d{8}\.1$/);
    NodeAssert.equal(provenance.upstreamTag, "v0.1.1-nightly.20261017.9000");
    NodeAssert.equal(provenance.sourceSha, sourceSha);
  },
);
