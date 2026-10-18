import * as NodePath from "node:path";
import {
  CLI_RELEASE_ORIGIN_FILE,
  CLI_RELEASE_PROVENANCE_FILE,
  cliArchiveFileName,
  isCliReleaseOrigin,
  parseCliReleaseProvenance,
} from "../../packages/shared/src/cliRelease.ts";

export function readLinuxCliArchive({ directory, version, sourceSha, run, stat }) {
  const name = cliArchiveFileName(version, "linux-x64");
  const archivePath = NodePath.join(directory, name);
  if (!stat(archivePath).isFile()) throw new Error("Linux CLI archive must be a regular file.");
  const tar = (args) =>
    run("/usr/bin/tar", args, {
      env: { PATH: "/usr/bin:/bin" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
    });
  const stem = name.slice(0, -".tar.gz".length);
  const members = tar(["-tzf", archivePath]).trim().split("\n");
  const readMetadata = (file) => {
    const member = `${stem}/${file}`;
    if (members.filter((entry) => entry === member).length !== 1) {
      throw new Error(`Linux CLI archive must contain exactly one ${file}.`);
    }
    return tar(["-xOzf", archivePath, member]);
  };
  const origin = readMetadata(CLI_RELEASE_ORIGIN_FILE);
  const metadata = readMetadata(CLI_RELEASE_PROVENANCE_FILE);
  const provenance = parseCliReleaseProvenance(metadata, { version, platformKey: "linux-x64" });
  if (
    !isCliReleaseOrigin(origin) ||
    provenance === undefined ||
    provenance.sourceSha !== sourceSha
  ) {
    throw new Error("Linux CLI archive origin or provenance does not match integration outputs.");
  }
  return { name, archivePath, provenance };
}
