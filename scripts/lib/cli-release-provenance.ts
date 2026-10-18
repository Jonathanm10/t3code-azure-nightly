// @effect-diagnostics nodeBuiltinImport:off - Build-time git and file inspection only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  CLI_RELEASE_REPOSITORY,
  type CliArchivePlatformKey,
  type CliReleaseProvenance,
} from "@t3tools/shared/cliRelease";
import { releasePackageFiles } from "./release-packages.ts";

export function resolveCliArchiveProvenance(input: {
  readonly repoRoot: string;
  readonly version: string;
  readonly platformKey: CliArchivePlatformKey;
  readonly sourceSha?: string | undefined;
}): CliReleaseProvenance {
  const git = (args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", [...args], {
      cwd: input.repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const sourceSha = git(["rev-parse", "HEAD"]);
  if (
    !/^[0-9a-f]{40}$/.test(sourceSha) ||
    (input.sourceSha !== undefined && input.sourceSha !== sourceSha)
  ) {
    throw new Error("CLI archive source SHA must match the checked-out candidate.");
  }
  const untracked = git(["ls-files", "--others", "--exclude-standard"]);
  if (untracked !== "")
    throw new Error("CLI archive requires a clean candidate without untracked files.");
  if (git(["diff", "--summary", "HEAD"]) !== "") {
    throw new Error("CLI archive source has file mode or path changes.");
  }
  const changed = git(["diff", "--name-only", "HEAD"]);
  for (const file of changed === "" ? [] : changed.split("\n")) {
    if (!releasePackageFiles.some((allowed) => allowed === file)) {
      throw new Error(`CLI archive source is dirty: ${file}`);
    }
    const original: unknown = JSON.parse(git(["show", `HEAD:${file}`]));
    const current: unknown = JSON.parse(
      NodeFS.readFileSync(NodePath.join(input.repoRoot, file), "utf8"),
    );
    if (
      typeof original !== "object" ||
      original === null ||
      typeof current !== "object" ||
      current === null ||
      JSON.stringify({ ...original, version: input.version }) !== JSON.stringify(current)
    ) {
      throw new Error(`Only the release version may change in ${file}.`);
    }
  }
  return {
    repository: CLI_RELEASE_REPOSITORY,
    version: input.version,
    sourceSha,
    platformKey: input.platformKey,
  };
}
