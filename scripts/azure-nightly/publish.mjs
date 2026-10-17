import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { compareVersions, sha256, validateCompleteAssets } from "./release-policy.mjs";

if (process.env.GITHUB_REF !== "refs/heads/release-control")
  throw new Error("Publication requires the protected release-control branch.");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token)
  throw new Error("Release repository and publisher token are required.");
const directory = NodePath.resolve(process.argv[2] ?? "signed");
const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(directory, "release-manifest.json"), "utf8"),
);
if (
  !/^[0-9a-f]{40}$/.test(manifest.sourceSha) ||
  manifest.controllerSha !== process.env.GITHUB_SHA ||
  !/^[A-Fa-f0-9]{40}$/.test(manifest.signingIdentitySha1) ||
  !manifest.notarizationId
)
  throw new Error("Signed release provenance is incomplete.");
const files = NodeFS.readdirSync(directory).map((name) => {
  const bytes = NodeFS.readFileSync(NodePath.resolve(directory, name));
  return { name, size: bytes.length, sha256: sha256(bytes), bytes };
});
const expected = [...manifest.assets, files.find((file) => file.name === "release-manifest.json")];
if (expected.some((file) => !file)) throw new Error("Release manifest is absent.");
validateCompleteAssets({ actual: files, expected });
const mandatory = [
  `T3-Code-Azure-${manifest.version}-arm64.zip`,
  `T3-Code-Azure-${manifest.version}-arm64.dmg`,
  "nightly-mac.yml",
  "release-manifest.json",
];
if (
  mandatory.some((name) => !files.some((file) => file.name === name)) ||
  files.filter((file) => file.name.endsWith(".tgz")).length !== 2
)
  throw new Error("Release is missing required desktop or standalone package assets.");
async function api(route, options = {}) {
  const response = await fetch(`https://api.github.com/repos/${repository}${route}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`Release API failed (${response.status}).`);
  return response.json();
}
const repositoryInfo = await api("");
if (repositoryInfo.private) throw new Error("The updater requires a public fork release feed.");
const releases = [];
for (let page = 1; page <= 10; page++) {
  const entries = await api(`/releases?per_page=100&page=${page}`);
  releases.push(...entries);
  if (entries.length < 100) break;
  if (page === 10) throw new Error("Release history exceeds the bounded publication lookup.");
}
for (const release of releases) {
  if (release.tag_name === `v${manifest.version}`)
    throw new Error("Release already exists; assets are immutable.");
  if (
    !release.draft &&
    /^v\d+\.\d+\.\d+(?:-nightly\.\d{8}\.\d+)?$/.test(release.tag_name) &&
    compareVersions(manifest.version, release.tag_name.slice(1)) <= 0
  )
    throw new Error("Release would downgrade the published feed.");
}
const gitEnv = {
  ...process.env,
  GH_TOKEN: "",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
};
for (const args of [
  ["fetch", "--no-tags", `https://github.com/${repository}.git`, manifest.sourceSha],
  [
    "push",
    `https://github.com/${repository}.git`,
    `${manifest.sourceSha}:refs/heads/azure-nightly`,
  ],
]) {
  try {
    NodeChildProcess.execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
      cwd: new URL("../..", import.meta.url),
      env: gitEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Checked fork promotion failed; publication remains closed.");
  }
}
const draft = await api("/releases", {
  method: "POST",
  body: JSON.stringify({
    tag_name: `v${manifest.version}`,
    target_commitish: manifest.sourceSha,
    name: `T3 Code (Azure Nightly) ${manifest.version}`,
    draft: true,
    prerelease: true,
    make_latest: "false",
    body: `Upstream ${manifest.upstreamTag} (${manifest.upstreamSha}).\nFork source ${manifest.sourceSha}.\nController ${manifest.controllerSha}.\nSigned and notarized macOS arm64. Standalone Azure core and MCP packages are included.`,
  }),
});
for (const file of files) {
  const response = await fetch(
    `${draft.upload_url.replace(/\{.*$/, "")}?name=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: file.bytes,
    },
  );
  if (!response.ok) throw new Error(`Draft asset upload failed (${response.status}).`);
}
const complete = await api(`/releases/${draft.id}`);
const verified = [];
for (const asset of complete.assets) {
  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: "application/octet-stream" } },
  );
  if (!response.ok) throw new Error("Draft asset reread failed.");
  const bytes = Buffer.from(await response.arrayBuffer());
  verified.push({ name: asset.name, size: bytes.length, sha256: sha256(bytes) });
}
validateCompleteAssets({ actual: verified, expected: files });
await api(`/releases/${draft.id}`, {
  method: "PATCH",
  body: JSON.stringify({ draft: false, prerelease: true, make_latest: "false" }),
});
const published = await api(`/releases/${draft.id}`);
if (
  published.draft ||
  !published.prerelease ||
  published.assets.length !== files.length ||
  published.immutable !== true
)
  throw new Error("Published release verification failed.");
const publicAssets = [];
for (const asset of published.assets) {
  const url = new URL(asset.browser_download_url);
  if (
    url.origin !== "https://github.com" ||
    !url.pathname.startsWith(`/${repository}/releases/download/`)
  )
    throw new Error("Unexpected public asset address.");
  const response = await fetch(url);
  if (!response.ok) throw new Error("Public release asset verification failed.");
  const bytes = Buffer.from(await response.arrayBuffer());
  publicAssets.push({ name: asset.name, size: bytes.length, sha256: sha256(bytes) });
}
validateCompleteAssets({ actual: publicAssets, expected: files });
