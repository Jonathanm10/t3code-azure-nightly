import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";

NodeTest.test(
  "integration uses the official Nightly source and versions from its concrete tag",
  async (t) => {
    const sourceSha = "a".repeat(40);
    const upstreamSha = "b".repeat(40);
    const writes = new Map();
    const gitFetches = [];
    const releaseRequests = [];
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
          if (args.includes("fetch")) gitFetches.push(args.slice(2));
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
      releaseRequests.push(url.pathname);
      if (url.pathname === "/repos/pingdotgg/t3code/releases")
        return Response.json([
          { id: 1, tag_name: "v0.1.1-nightly.20261017.9000", draft: false, prerelease: true },
        ]);
      if (url.pathname === "/repos/fixture/fork/releases") return Response.json([]);
      return Response.json({ message: "Not Found" }, { status: 404 });
    });
    await import("./integrate.mjs?fixture=upstream-tag");
    const provenance = JSON.parse([...writes.values()][0]);
    NodeAssert.match(provenance.version, /^0\.1\.1-nightly\.\d{8}\.1$/);
    NodeAssert.equal(provenance.upstreamTag, "v0.1.1-nightly.20261017.9000");
    NodeAssert.equal(provenance.sourceSha, sourceSha);
    NodeAssert.deepEqual(releaseRequests, [
      "/repos/pingdotgg/t3code/releases",
      "/repos/fixture/fork/releases",
    ]);
    NodeAssert.deepEqual(gitFetches, [
      [
        "fetch",
        "--no-tags",
        "https://github.com/pingdotgg/t3code.git",
        "refs/tags/v0.1.1-nightly.20261017.9000",
      ],
    ]);
  },
);

async function integrateAgainstConflictingUpstream(t, { eventName, forkUnchanged, lagDays }) {
  const forkSha = "a".repeat(40);
  const upstreamSha = "b".repeat(40);
  const baseSha = "d".repeat(40);
  const upstreamTime = 1_800_000_000;
  const writes = new Map();
  const appends = [];
  const gitCalls = [];
  t.mock.module("node:fs", {
    namedExports: {
      writeFileSync: (path, contents) => writes.set(path, contents),
      appendFileSync: (path, contents) => appends.push(contents),
    },
  });
  t.mock.module("node:child_process", {
    namedExports: {
      execFileSync: (command, args) => {
        const [subcommand, ...rest] = args.slice(2);
        gitCalls.push(args.slice(2).join(" "));
        if (subcommand === "rev-parse") return rest[0] === "HEAD" ? forkSha : upstreamSha;
        if (subcommand === "merge" && rest[0] === "--no-edit") throw new Error("conflict");
        if (subcommand === "diff")
          return "apps/server/src/serviceLauncher.ts\ndocs/user/source-control.md";
        if (subcommand === "merge-base") return baseSha;
        if (subcommand === "show")
          return String(
            rest.at(-1) === upstreamSha ? upstreamTime : upstreamTime - lagDays * 86_400,
          );
        if (subcommand === "ls-remote")
          return `${"e".repeat(40)}\trefs/tags/v0.1.1-nightly.20261020.3401\n${baseSha}\trefs/tags/v0.1.1-nightly.20261020.3386`;
        return "";
      },
    },
  });
  const previous = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REF: "refs/heads/release-control",
    GITHUB_REPOSITORY: "fixture/fork",
    GITHUB_SHA: "c".repeat(40),
    GH_TOKEN: "fixture-token",
    GITHUB_EVENT_NAME: eventName,
    GITHUB_OUTPUT: "/fixture/output",
    GITHUB_STEP_SUMMARY: "/fixture/summary",
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
  });
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = new URL(input);
    if (url.pathname === "/repos/pingdotgg/t3code/releases")
      return Response.json([
        { id: 2, tag_name: "v0.1.1-nightly.20261020.3411", draft: false, prerelease: true },
      ]);
    if (url.pathname === "/repos/fixture/fork/releases")
      return Response.json([
        {
          tag_name: "v0.1.1-nightly.20261020.1",
          draft: false,
          assets: [{ id: 7, name: "release-manifest.json" }],
        },
      ]);
    if (url.pathname === "/repos/fixture/fork/releases/assets/7")
      return Response.json({
        sourceSha: forkUnchanged ? forkSha : "f".repeat(40),
        upstreamSha: baseSha,
      });
    return Response.json({ message: "Not Found" }, { status: 404 });
  });
  class Exit extends Error {}
  t.mock.method(process, "exit", () => {
    throw new Exit();
  });
  let outcome = "built";
  try {
    await import(`./integrate.mjs?fixture=conflict-${eventName}-${forkUnchanged}-${lagDays}`);
  } catch (error) {
    if (!(error instanceof Exit)) throw error;
    outcome = "skipped";
  }
  const provenance = writes.size ? JSON.parse([...writes.values()][0]) : undefined;
  return { outcome, provenance, appends: appends.join(""), gitCalls, forkSha, baseSha };
}

NodeTest.test(
  "an upstream conflict ships fork changes on the fork's current upstream base",
  async (t) => {
    const run = await integrateAgainstConflictingUpstream(t, {
      eventName: "workflow_dispatch",
      forkUnchanged: true,
      lagDays: 30,
    });
    NodeAssert.equal(run.outcome, "built");
    NodeAssert.ok(run.gitCalls.includes("merge --abort"));
    NodeAssert.equal(run.provenance.sourceSha, run.forkSha);
    NodeAssert.equal(run.provenance.upstreamSha, run.baseSha);
    NodeAssert.equal(run.provenance.upstreamTag, "v0.1.1-nightly.20261020.3386");
    NodeAssert.match(
      run.appends,
      /upstream_sha=d{40}\nupstream_tag=v0\.1\.1-nightly\.20261020\.3386/,
    );
    NodeAssert.match(
      run.appends,
      /conflicts with the fork in 2 files:\n- apps\/server\/src\/serviceLauncher\.ts/,
    );
  },
);

NodeTest.test(
  "a scheduled run skips quietly while the conflicting fork is under a week behind",
  async (t) => {
    const run = await integrateAgainstConflictingUpstream(t, {
      eventName: "schedule",
      forkUnchanged: true,
      lagDays: 3,
    });
    NodeAssert.equal(run.outcome, "skipped");
    NodeAssert.equal(run.provenance, undefined);
    NodeAssert.match(run.appends, /should_build=false/);
    NodeAssert.match(
      run.appends,
      /stays on v0\.1\.1-nightly\.20261020\.3386 \(d{40}\), 3 days behind/,
    );
    NodeAssert.ok(!run.gitCalls.some((call) => call.startsWith("push")));
  },
);

NodeTest.test("a scheduled run still builds a changed fork despite the conflict", async (t) => {
  const run = await integrateAgainstConflictingUpstream(t, {
    eventName: "schedule",
    forkUnchanged: false,
    lagDays: 3,
  });
  NodeAssert.equal(run.outcome, "built");
  NodeAssert.equal(run.provenance.upstreamSha, run.baseSha);
});

NodeTest.test(
  "a scheduled run fails once the conflicting fork falls over a week behind",
  async (t) => {
    await NodeAssert.rejects(
      integrateAgainstConflictingUpstream(t, {
        eventName: "schedule",
        forkUnchanged: true,
        lagDays: 8,
      }),
      /8 days behind\.\nResync: merge v0\.1\.1-nightly\.20261020\.3411 into azure-nightly by hand/,
    );
  },
);
