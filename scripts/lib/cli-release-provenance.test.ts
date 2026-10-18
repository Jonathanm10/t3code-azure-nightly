// @effect-diagnostics nodeBuiltinImport:off - Uses real isolated git trees to check archive provenance.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { cliReleaseProvenanceJson, CLI_RELEASE_REPOSITORY } from "@t3tools/shared/cliRelease";
import { resolveCliArchiveProvenance } from "./cli-release-provenance.ts";

it("pins the actual clean candidate and allows only the exact version stamp", () => {
  const repoRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-provenance-"));
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  try {
    git("init");
    NodeFS.mkdirSync(NodePath.join(repoRoot, "apps/server"), { recursive: true });
    const manifestPath = NodePath.join(repoRoot, "apps/server/package.json");
    const manifest = { name: "t3", version: "1.0.0", private: true };
    NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
    NodeFS.writeFileSync(NodePath.join(repoRoot, "code.ts"), "export const fixture = 1;\n");
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".gitignore"), ".env\n");
    git("add", ".");
    git("-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture");
    const sourceSha = git("rev-parse", "HEAD");
    const input = {
      repoRoot,
      sourceSha,
      version: "1.0.0-nightly.20261018.2",
      platformKey: "linux-x64",
    } as const;
    expect(resolveCliArchiveProvenance(input).sourceSha).toBe(sourceSha);
    expect(() => resolveCliArchiveProvenance({ ...input, sourceSha: "b".repeat(40) })).toThrow(
      /checked-out candidate/,
    );
    NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: input.version }));
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env"), "PRIVATE_FIXTURE=do-not-archive\n");
    const provenance = resolveCliArchiveProvenance(input);
    expect(JSON.parse(cliReleaseProvenanceJson(provenance))).toEqual({
      repository: CLI_RELEASE_REPOSITORY,
      version: input.version,
      sourceSha,
      platformKey: "linux-x64",
    });
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({ ...manifest, version: input.version, private: false }),
    );
    expect(() => resolveCliArchiveProvenance(input)).toThrow(/Only the release version/);
    NodeFS.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: input.version }));
    NodeFS.writeFileSync(NodePath.join(repoRoot, "code.ts"), "export const fixture = 2;\n");
    expect(() => resolveCliArchiveProvenance(input)).toThrow(/source is dirty/);
    git("restore", "code.ts");
    NodeFS.writeFileSync(NodePath.join(repoRoot, "unexpected"), "untracked input");
    expect(() => resolveCliArchiveProvenance(input)).toThrow(/untracked/);
  } finally {
    NodeFS.rmSync(repoRoot, { recursive: true, force: true });
  }
});
