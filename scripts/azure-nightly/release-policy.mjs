import * as NodeCrypto from "node:crypto";

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-nightly\.(\d{8})\.(0|[1-9]\d*))?$/;
function parse(version) {
  const match = versionPattern.exec(version);
  if (!match) throw new Error(`Unsupported fork release version: ${version}`);
  return match.slice(1).map((part) => (part === undefined ? undefined : BigInt(part)));
}
export function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  if (left[3] === undefined || right[3] === undefined)
    return left[3] === right[3] ? 0 : left[3] === undefined ? 1 : -1;
  for (let i = 3; i < 5; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
export function nextForkVersion({ upstreamVersion, existingVersions, date }) {
  if (!/^\d{8}$/.test(date)) throw new Error("Invalid release date.");
  const upstreamCore = upstreamVersion.replace(/[-+].*$/, "");
  parse(upstreamCore);
  const latest = [...existingVersions].sort(compareVersions).at(-1);
  let core = upstreamCore;
  let day = date;
  let sequence = 1n;
  if (latest) {
    const latestCore = latest.split("-")[0];
    if (compareVersions(core, latestCore) < 0) core = latestCore;
    const previous = parse(latest);
    if (latest === core) {
      const parts = core.split(".");
      core = `${parts[0]}.${parts[1]}.${BigInt(parts[2]) + 1n}`;
    } else if (latestCore === core && previous[3] !== undefined) {
      if (BigInt(day) < previous[3]) day = String(previous[3]);
      if (BigInt(day) === previous[3]) sequence = previous[4] + 1n;
    }
  }
  const result = `${core}-nightly.${day}.${sequence}`;
  if (latest && compareVersions(result, latest) <= 0)
    throw new Error("Fork version would not advance.");
  return result;
}
export function selectUpstreamNightly(releases) {
  const candidates = releases.filter(
    (release) =>
      !release.draft &&
      release.prerelease &&
      /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(release.tag_name),
  );
  candidates.sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)));
  const release = candidates.at(-1);
  if (!release) throw new Error("No concrete upstream Nightly release found.");
  return { tag: release.tag_name, releaseId: release.id };
}
export function sha256(bytes) {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
export function validateCompleteAssets({ actual, expected }) {
  const names = actual.map((asset) => asset.name).sort();
  const required = expected.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(required))
    throw new Error("Release asset set is incomplete or contains unexpected files.");
  for (const asset of expected) {
    const uploaded = actual.find((value) => value.name === asset.name);
    if (uploaded.size !== asset.size || uploaded.sha256 !== asset.sha256)
      throw new Error(`Release asset verification failed: ${asset.name}`);
  }
}

export function validateStandalonePackageProvenance({ metadata, sourceSha }) {
  if (
    typeof metadata?.name !== "string" ||
    !/^@jonathanm10\/azure-devops-server-(client|mcp)$/.test(metadata.name) ||
    metadata.source !== sourceSha ||
    metadata.sourceTreeDirty !== false ||
    typeof metadata.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(metadata.version)
  )
    throw new Error("Standalone package provenance does not match the clean candidate.");
}

export function shouldBuildNightly({ eventName, upstreamSha, baseForkSha, lastPublished }) {
  return (
    eventName !== "schedule" ||
    !lastPublished ||
    lastPublished.upstreamSha !== upstreamSha ||
    lastPublished.sourceSha !== baseForkSha
  );
}
