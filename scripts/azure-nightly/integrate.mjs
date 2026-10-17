import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  nextForkVersion,
  selectUpstreamNightly,
  compareVersions,
  shouldBuildNightly,
} from "./release-policy.mjs";

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
  throw new Error("Fork repository and integration token are required.");
if (process.env.GITHUB_REF !== "refs/heads/release-control")
  throw new Error("Integration must run from the protected release-control branch.");
const candidate = NodePath.resolve(process.argv[2] ?? "candidate");
async function releases(repo) {
  const result = [];
  for (let page = 1; page <= 10; page++) {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!response.ok) throw new Error(`Release lookup failed (${response.status}).`);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error("Invalid release list.");
    result.push(...entries);
    if (entries.length < 100) return result;
  }
  throw new Error("Release history exceeds the bounded lookup.");
}
const upstream = selectUpstreamNightly(await releases("t3tools/t3code"));
const git = (args, env = {}) =>
  NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd: candidate,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env, GH_TOKEN: "" },
  }).trim();
const baseForkSha = git(["rev-parse", "HEAD"]);
git(["config", "user.name", "Azure Nightly Integration"]);
git(["config", "user.email", "azure-nightly@users.noreply.github.com"]);
git(["fetch", "--no-tags", "https://github.com/t3tools/t3code.git", `refs/tags/${upstream.tag}`]);
const upstreamSha = git(["rev-parse", "FETCH_HEAD^{commit}"]);
if (!/^[0-9a-f]{40}$/.test(upstreamSha)) throw new Error("Invalid upstream source commit.");
const ownReleases = await releases(repository);
const lastSuccessful = ownReleases
  .filter(
    (release) => !release.draft && /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(release.tag_name),
  )
  .sort((a, b) => compareVersions(a.tag_name.slice(1), b.tag_name.slice(1)))
  .at(-1);
const previousManifest = lastSuccessful?.assets?.find(
  (asset) => asset.name === "release-manifest.json",
);
let lastPublished;
if (previousManifest) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/assets/${previousManifest.id}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" } },
  );
  if (!response.ok) throw new Error("Last successful release provenance could not be read.");
  lastPublished = await response.json();
  if (
    !/^[0-9a-f]{40}$/.test(lastPublished.sourceSha) ||
    !/^[0-9a-f]{40}$/.test(lastPublished.upstreamSha)
  )
    throw new Error("Last successful release provenance is invalid.");
}
if (
  !shouldBuildNightly({
    eventName: process.env.GITHUB_EVENT_NAME,
    upstreamSha,
    baseForkSha,
    lastPublished,
  })
) {
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, "should_build=false\n");
  if (process.env.GITHUB_STEP_SUMMARY)
    NodeFS.appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      "Upstream Nightly and the maintained fork are unchanged. No build or release was created.\n",
    );
  process.exit(0);
}
git(["merge", "--no-edit", "--no-ff", upstreamSha]);
const sourceSha = git(["rev-parse", "HEAD"]);
const upstreamVersion = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(candidate, "apps/desktop/package.json"), "utf8"),
).version;
const existingVersions = ownReleases
  .filter((release) => /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(release.tag_name))
  .map((release) => release.tag_name.slice(1));
const version = nextForkVersion({
  upstreamVersion,
  existingVersions,
  date: new Date().toISOString().slice(0, 10).replaceAll("-", ""),
});
const pushEnv = {
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
};
git(
  [
    "push",
    `https://github.com/${repository}.git`,
    `HEAD:refs/heads/azure-nightly-candidates/${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
  ],
  pushEnv,
);
const provenance = {
  version,
  sourceSha,
  upstreamSha,
  upstreamTag: upstream.tag,
  upstreamReleaseId: upstream.releaseId,
  controllerSha: process.env.GITHUB_SHA,
};
NodeFS.writeFileSync(
  NodePath.resolve(candidate, "azure-nightly-provenance.json"),
  JSON.stringify(provenance, null, 2),
);
if (process.env.GITHUB_OUTPUT)
  NodeFS.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `should_build=true\nversion=${version}\nsource_sha=${sourceSha}\nupstream_sha=${upstreamSha}\nupstream_tag=${upstream.tag}\n`,
  );
