import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import {
  compareVersions,
  nextForkVersion,
  selectUpstreamNightly,
  validateCompleteAssets,
  shouldBuildNightly,
  validateStandalonePackageProvenance,
} from "./release-policy.mjs";

NodeTest.test(
  "fork versions advance across source downgrades, stable releases and clock rollback",
  () => {
    const cases = [
      {
        upstreamVersion: "0.1.2-nightly.20261016.9000",
        existingVersions: [],
        date: "20261017",
        expected: "0.1.2-nightly.20261017.1",
      },
      {
        upstreamVersion: "0.1.1",
        existingVersions: ["0.2.0-nightly.20261018.8"],
        date: "20261017",
        expected: "0.2.0-nightly.20261018.9",
      },
      {
        upstreamVersion: "0.1.2",
        existingVersions: ["0.1.2"],
        date: "20261017",
        expected: "0.1.3-nightly.20261017.1",
      },
      {
        upstreamVersion: "0.3.0",
        existingVersions: ["0.2.0-nightly.20261018.8"],
        date: "20261017",
        expected: "0.3.0-nightly.20261017.1",
      },
    ];
    for (const { expected, ...input } of cases) {
      const actual = nextForkVersion(input);
      NodeAssert.equal(actual, expected);
      for (const previous of input.existingVersions)
        NodeAssert.equal(compareVersions(actual, previous), 1);
    }
  },
);
NodeTest.test("standalone packages require clean provenance for the exact candidate", () => {
  const sourceSha = "a".repeat(40);
  const metadata = {
    name: "@jonathanm10/azure-devops-server-client",
    version: "0.1.0",
    source: sourceSha,
    sourceTreeDirty: false,
  };
  validateStandalonePackageProvenance({ metadata, sourceSha });
  for (const invalid of [
    { ...metadata, sourceTreeDirty: true },
    { ...metadata, sourceTreeDirty: undefined },
    { ...metadata, source: "b".repeat(40) },
    { ...metadata, name: "other" },
  ]) {
    NodeAssert.throws(
      () => validateStandalonePackageProvenance({ metadata: invalid, sourceSha }),
      /clean candidate/,
    );
  }
});
NodeTest.test(
  "resolves a published upstream Nightly, ignoring drafts, stable and preview tags",
  () => {
    const release = (tag_name, draft = false, prerelease = true) => ({
      id: tag_name,
      tag_name,
      draft,
      prerelease,
    });
    NodeAssert.deepEqual(
      selectUpstreamNightly([
        release("v0.1.0-nightly.20261017.1"),
        release("v0.1.0-nightly.20261018.2", true),
        release("v0.2.0", false, false),
        release("v0.1.0-preview.20261019.1"),
      ]),
      { tag: "v0.1.0-nightly.20261017.1", releaseId: "v0.1.0-nightly.20261017.1" },
    );
    NodeAssert.throws(() => selectUpstreamNightly([]));
  },
);
NodeTest.test("publication refuses partial, extra and replaced assets", () => {
  const expected = [
    { name: "mac.zip", size: 12, sha256: "abc" },
    { name: "nightly-mac.yml", size: 5, sha256: "def" },
  ];
  validateCompleteAssets({ expected, actual: expected });
  for (const actual of [
    expected.slice(1),
    [...expected, { name: "extra" }],
    [{ ...expected[0], sha256: "tampered" }, expected[1]],
  ])
    NodeAssert.throws(() => validateCompleteAssets({ expected, actual }));
});

NodeTest.test(
  "unchanged schedules are a no-op while manual dispatch and source changes build",
  () => {
    const unchanged = {
      eventName: "schedule",
      upstreamSha: "upstream",
      baseForkSha: "fork",
      lastPublished: { upstreamSha: "upstream", sourceSha: "fork" },
    };
    NodeAssert.equal(shouldBuildNightly(unchanged), false);
    NodeAssert.equal(shouldBuildNightly({ ...unchanged, eventName: "workflow_dispatch" }), true);
    NodeAssert.equal(shouldBuildNightly({ ...unchanged, upstreamSha: "new-upstream" }), true);
    NodeAssert.equal(shouldBuildNightly({ ...unchanged, baseForkSha: "new-patch" }), true);
    NodeAssert.equal(shouldBuildNightly({ ...unchanged, lastPublished: undefined }), true);
  },
);
