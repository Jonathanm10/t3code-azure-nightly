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
const upstreamRepository = "pingdotgg/t3code";
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
const upstream = selectUpstreamNightly(await releases(upstreamRepository));
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
git([
  "fetch",
  "--no-tags",
  `https://github.com/${upstreamRepository}.git`,
  `refs/tags/${upstream.tag}`,
]);
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
function summarize(text) {
  if (process.env.GITHUB_STEP_SUMMARY) NodeFS.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
function skipBuild(text) {
  if (process.env.GITHUB_OUTPUT)
    NodeFS.appendFileSync(process.env.GITHUB_OUTPUT, "should_build=false\n");
  summarize(text);
  process.exit(0);
}
const eventName = process.env.GITHUB_EVENT_NAME;
if (!shouldBuildNightly({ eventName, upstreamSha, baseForkSha, lastPublished }))
  skipBuild(
    "Upstream Nightly and the maintained fork are unchanged. No build or release was created.\n",
  );
// An upstream conflict must not block fork fixes, so the fork keeps its current upstream base
// until a hand resync, and only fails once that base falls a week behind.
const maxUpstreamLagDays = 7;
const commitTime = (sha) => Number(git(["show", "-s", "--format=%ct", sha]));
function upstreamNightlyTagAt(sha) {
  const refs = git([
    "ls-remote",
    "--tags",
    `https://github.com/${upstreamRepository}.git`,
    "v*-nightly.*",
  ]);
  for (const line of refs.split("\n")) {
    const [refSha, ref = ""] = line.split("\t");
    const tag = /^refs\/tags\/(v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+)(?:\^\{\})?$/.exec(ref)?.[1];
    if (tag && refSha === sha) return tag;
  }
  return null;
}
let built = { upstreamSha, upstreamTag: upstream.tag, upstreamReleaseId: upstream.releaseId };
try {
  git(["merge", "--no-edit", "--no-ff", upstreamSha]);
} catch (error) {
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  if (conflicts.length === 0) throw error;
  git(["merge", "--abort"]);
  const baseUpstreamSha = git(["merge-base", "HEAD", upstreamSha]);
  const baseUpstreamTag = upstreamNightlyTagAt(baseUpstreamSha) ?? "untagged upstream";
  const lagDays = Math.floor((commitTime(upstreamSha) - commitTime(baseUpstreamSha)) / 86_400);
  const report = [
    `Upstream ${upstream.tag} conflicts with the fork in ${conflicts.length} files:`,
    ...conflicts.map((path) => `- ${path}`),
    `The fork stays on ${baseUpstreamTag} (${baseUpstreamSha}), ${lagDays} days behind.`,
    "",
  ].join("\n");
  const resync = `Resync: merge ${upstream.tag} into azure-nightly by hand, then push azure-nightly and release-control.`;
  if (
    !shouldBuildNightly({ eventName, upstreamSha: baseUpstreamSha, baseForkSha, lastPublished })
  ) {
    if (lagDays > maxUpstreamLagDays) throw new Error(`${report}${resync}`, { cause: error });
    skipBuild(`${report}The fork is unchanged since its last release. No build was created.\n`);
  }
  console.log(
    `::warning::Upstream ${upstream.tag} conflicts; building the fork on ${baseUpstreamTag}.`,
  );
  summarize(`${report}Building the fork on its current upstream base.\n${resync}\n`);
  built = { upstreamSha: baseUpstreamSha, upstreamTag: baseUpstreamTag, upstreamReleaseId: null };
}
const sourceSha = git(["rev-parse", "HEAD"]);
const existingVersions = ownReleases
  .filter((release) => /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(release.tag_name))
  .map((release) => release.tag_name.slice(1));
const version = nextForkVersion({
  upstreamVersion: upstream.tag.slice(1),
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
  ...built,
  controllerSha: process.env.GITHUB_SHA,
};
NodeFS.writeFileSync(
  NodePath.resolve(candidate, "azure-nightly-provenance.json"),
  JSON.stringify(provenance, null, 2),
);
if (process.env.GITHUB_OUTPUT)
  NodeFS.appendFileSync(
    process.env.GITHUB_OUTPUT,
    `should_build=true\nversion=${version}\nsource_sha=${sourceSha}\nupstream_sha=${built.upstreamSha}\nupstream_tag=${built.upstreamTag}\n`,
  );
