export const CLI_RELEASE_REPOSITORY = "Jonathanm10/t3code-azure-nightly";
export const CLI_RELEASE_ORIGIN_FILE = ".release-origin";
export const CLI_RELEASE_PROVENANCE_FILE = ".release-provenance.json";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "T3CODE_RELEASE_BASE_URL";

/**
 * Kept in step with the build_linux_cli matrix, build_windows_arm64_cli, and
 * the `cli_archive` rows in .github/workflows/release.yml: a key here without a
 * build there produces download URLs that 404, and a build there without a key
 * here is unreachable from every installer.
 */
// No darwin-x64: Node single-executables are unsupported on x64 macOS (the
// SEA docs list macOS as arm64 only) and the binary segfaults on start.
const CLI_ARCHIVE_PLATFORM_KEYS = [
  "darwin-arm64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export interface CliReleaseProvenance {
  readonly repository: typeof CLI_RELEASE_REPOSITORY;
  readonly version: string;
  readonly sourceSha: string;
  readonly platformKey: CliArchivePlatformKey;
}

export function parseCliReleaseProvenance(
  text: string,
  expected: Pick<CliReleaseProvenance, "version" | "platformKey">,
): CliReleaseProvenance | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("repository" in value) ||
    value.repository !== CLI_RELEASE_REPOSITORY ||
    !("version" in value) ||
    value.version !== expected.version ||
    !("platformKey" in value) ||
    value.platformKey !== expected.platformKey ||
    !("sourceSha" in value) ||
    typeof value.sourceSha !== "string" ||
    !/^[0-9a-f]{40}$/.test(value.sourceSha)
  )
    return undefined;
  return {
    repository: CLI_RELEASE_REPOSITORY,
    version: expected.version,
    sourceSha: value.sourceSha,
    platformKey: expected.platformKey,
  };
}

export function isCliReleaseOrigin(text: string): boolean {
  return text === CLI_RELEASE_REPOSITORY || text === `${CLI_RELEASE_REPOSITORY}\n`;
}

export function cliReleaseProvenanceJson(provenance: CliReleaseProvenance): string {
  return JSON.stringify({
    repository: provenance.repository,
    version: provenance.version,
    sourceSha: provenance.sourceSha,
    platformKey: provenance.platformKey,
  });
}

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  const key = `${platform}-${arch}`;
  return CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === key);
}

/**
 * Windows ships bsdtar in System32, which reads both formats; a Git-for-Windows
 * GNU tar earlier on PATH cannot open the zip, so the system copy is named by
 * absolute path.
 */
export function cliArchiveTarCommand(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform !== "win32") return "tar";
  const systemRoot = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return `${systemRoot}\\System32\\tar.exe`;
}

export function cliArchiveFileName(version: string, platformKey: CliArchivePlatformKey): string {
  return `t3-${version}-${platformKey}.${platformKey.startsWith("win32") ? "zip" : "tar.gz"}`;
}

const CLI_RELEASE_DEFAULT_BASE_URL = `https://github.com/${CLI_RELEASE_REPOSITORY}/releases/download`;

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = CLI_RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || CLI_RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}

export type CliReleaseChannel = "stable" | "nightly" | "preview";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = [
  "stable",
  "nightly",
  "preview",
];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  const channel = /^[^-+]+-(nightly|preview)\.\d{8}\.\d+$/.exec(version)?.[1];
  return channel === "nightly" || channel === "preview" ? channel : "stable";
}

/**
 * Callers walk pages until a channel match turns up; a busy nightly train can push the newest
 * preview or stable release past any single page.
 */
export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${CLI_RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

/**
 * Drafts are skipped because their assets are not downloadable.
 */
export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(release.tag_name)?.[1];
    if (version === undefined) continue;
    if (cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}

// Canonical JSON keeps the bootstrap usable on hosts without Node or jq.
export const CLI_RELEASE_METADATA_SHELL = String.raw`T3_RELEASE_REPOSITORY='${CLI_RELEASE_REPOSITORY}'
t3_release_metadata_matches() {
  _t3_release_dir="$1"
  _t3_release_version="$2"
  _t3_release_platform="$3"
  [ "$(cat "$_t3_release_dir/.release-origin" 2>/dev/null)" = "$T3_RELEASE_REPOSITORY" ] || return 1
  _t3_release_json="$(cat "$_t3_release_dir/.release-provenance.json" 2>/dev/null)" || return 1
  _t3_release_sha="$(printf '%s\n' "$_t3_release_json" | sed -n 's/^.*"sourceSha":"\([0-9a-f]\{40\}\)".*$/\1/p')"
  [ -n "$_t3_release_sha" ] || return 1
  [ "$_t3_release_json" = "$(printf '{"repository":"%s","version":"%s","sourceSha":"%s","platformKey":"%s"}' "$T3_RELEASE_REPOSITORY" "$_t3_release_version" "$_t3_release_sha" "$_t3_release_platform")" ]
}
`;
