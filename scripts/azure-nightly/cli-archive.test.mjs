import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { readLinuxCliArchive } from "./cli-archive.mjs";

const repository = "Jonathanm10/t3code-azure-nightly";
const version = "0.1.1-nightly.20261018.2";
const sourceSha = "a".repeat(40);

for (const failure of [
  undefined,
  "missing-origin",
  "foreign",
  "source",
  "version",
  "platform",
  "missing-archive",
]) {
  NodeTest.test(`passively checks a real Linux archive (${failure ?? "valid"})`, (t) => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "azure-cli-data-"));
    t.after(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const stem = `t3-${version}-linux-x64`;
    const stage = NodePath.join(directory, stem);
    NodeFS.mkdirSync(stage);
    const metadata = {
      repository,
      version,
      sourceSha,
      platformKey: "linux-x64",
      ...(failure === "source" ? { sourceSha: "b".repeat(40) } : {}),
      ...(failure === "version" ? { version: "9.9.9" } : {}),
      ...(failure === "platform" ? { platformKey: "darwin-arm64" } : {}),
    };
    if (failure !== "missing-origin")
      NodeFS.writeFileSync(
        NodePath.join(stage, ".release-origin"),
        `${failure === "foreign" ? "pingdotgg/t3code" : repository}\n`,
      );
    NodeFS.writeFileSync(
      NodePath.join(stage, ".release-provenance.json"),
      JSON.stringify(metadata),
    );
    const executed = NodePath.join(directory, "candidate-executed");
    NodeFS.writeFileSync(NodePath.join(stage, "t3"), `#!/bin/sh\ntouch '${executed}'\n`, {
      mode: 0o755,
    });
    const name = `${stem}.tar.gz`;
    NodeChildProcess.execFileSync("/usr/bin/tar", [
      "-czf",
      NodePath.join(directory, name),
      "-C",
      directory,
      stem,
    ]);
    if (failure === "missing-archive")
      NodeFS.renameSync(NodePath.join(directory, name), NodePath.join(directory, "wrong.tar.gz"));
    const inspect = () =>
      readLinuxCliArchive({
        directory,
        version,
        sourceSha,
        run: NodeChildProcess.execFileSync,
        stat: NodeFS.lstatSync,
      });
    if (failure) NodeAssert.throws(inspect);
    else NodeAssert.deepEqual(inspect().provenance, metadata);
    NodeAssert.equal(NodeFS.existsSync(executed), false);
  });
}
