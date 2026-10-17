import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { sha256 } from "./release-policy.mjs";

async function fixture(t, tampered = false) {
  const version = "0.1.1-nightly.20261017.1";
  const repository = "fixture/fork";
  const payloads = Object.fromEntries(
    [
      `T3-Code-Azure-${version}-arm64.zip`,
      `T3-Code-Azure-${version}-arm64.dmg`,
      "nightly-mac.yml",
      "client.tgz",
      "mcp.tgz",
    ].map((name) => [name, Buffer.from(`fixture ${name}`)]),
  );
  const assets = Object.entries(payloads).map(([name, bytes], index) => ({
    name,
    size: bytes.length,
    sha256: sha256(bytes),
    id: index + 1,
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
  }));
  const manifest = {
    version,
    sourceSha: "a".repeat(40),
    upstreamSha: "b".repeat(40),
    controllerSha: "c".repeat(40),
    signingIdentitySha1: "d".repeat(40),
    notarizationId: "fixture-notary",
    assets,
  };
  payloads["release-manifest.json"] = Buffer.from(JSON.stringify(manifest));
  const manifestBytes = payloads["release-manifest.json"];
  assets.push({
    name: "release-manifest.json",
    size: manifestBytes.length,
    sha256: sha256(manifestBytes),
    id: 6,
    browser_download_url: `https://github.com/${repository}/releases/download/v${version}/release-manifest.json`,
  });
  t.mock.module("node:fs", {
    namedExports: {
      readdirSync: () => Object.keys(payloads),
      readFileSync: (filename) => payloads[String(filename).split("/").at(-1)],
    },
  });
  const commands = [];
  t.mock.module("node:child_process", {
    namedExports: {
      execFileSync: (...args) => {
        commands.push(args);
        return "";
      },
    },
  });
  const prior = { ...process.env };
  Object.assign(process.env, {
    GITHUB_REF: "refs/heads/release-control",
    GITHUB_REPOSITORY: repository,
    GITHUB_SHA: manifest.controllerSha,
    GH_TOKEN: "fixture-token",
  });
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
  });
  const requests = [];
  let published = false;
  t.mock.method(globalThis, "fetch", async (input, options = {}) => {
    const url = new URL(input);
    const method = options.method ?? "GET";
    requests.push({ method, pathname: url.pathname });
    if (url.hostname === "uploads.github.com") return Response.json({});
    if (url.hostname === "github.com")
      return new Response(payloads[decodeURIComponent(url.pathname.split("/").at(-1))]);
    if (url.pathname === `/repos/${repository}`) return Response.json({ private: false });
    if (url.pathname === `/repos/${repository}/releases` && method === "GET")
      return Response.json([{ tag_name: "v0.1.0-nightly.20261016.1", draft: false }]);
    if (url.pathname === `/repos/${repository}/releases` && method === "POST")
      return Response.json({
        id: 1,
        upload_url: "https://uploads.github.com/fixture/assets{?name,label}",
      });
    if (url.pathname === `/repos/${repository}/releases/1` && method === "PATCH") {
      published = true;
      return Response.json({});
    }
    if (url.pathname === `/repos/${repository}/releases/1`)
      return Response.json({ assets, draft: !published, prerelease: true, immutable: published });
    const assetId = /\/releases\/assets\/(\d+)$/.exec(url.pathname)?.[1];
    if (assetId)
      return new Response(tampered ? "tampered" : payloads[assets[Number(assetId) - 1].name]);
    throw new Error("Unexpected fixture request.");
  });
  return { requests, commands, isPublished: () => published };
}

NodeTest.test(
  "publishes only after rereading every complete draft asset and then verifies public bytes",
  async (t) => {
    const state = await fixture(t);
    await import(`./publish.mjs?complete=${Date.now()}`);
    NodeAssert.equal(state.isPublished(), true);
    NodeAssert.equal(state.commands.length, 2);
    NodeAssert.equal(state.requests.filter((request) => request.method === "DELETE").length, 0);
    NodeAssert.equal(
      state.requests.filter((request) => request.pathname.includes("/releases/download/")).length,
      6,
    );
  },
);

NodeTest.test(
  "a mismatched draft byte prevents publication and never deletes the last good release",
  async (t) => {
    const state = await fixture(t, true);
    await NodeAssert.rejects(import(`./publish.mjs?tampered=${Date.now()}`), /verification failed/);
    NodeAssert.equal(state.isPublished(), false);
    NodeAssert.equal(
      state.requests.some((request) => request.method === "PATCH" || request.method === "DELETE"),
      false,
    );
  },
);
