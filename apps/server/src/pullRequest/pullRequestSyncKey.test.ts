import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestSyncKey } from "./pullRequestSyncKey.ts";

describe("pullRequestSyncKey", () => {
  const reference = { projectId: ProjectId.make("project"), repository: "web", number: 7 };
  it("recovers configured Server identities and browser aliases without rewriting stored projects", () => {
    const profiles = [
      {
        apiCollectionUrl: "https://git.example.test:8443/tfs/C",
        browserCollectionUrl: "https://web.example.test/C",
      },
    ];
    const identity = {
      canonicalKey: "git.example.test/tfs/c/p/_git/web",
      provider: "unknown",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "https://git.example.test:8443/tfs/C/P/_git/Web",
      },
    };
    const expected = { host: "git.example.test:8443", repository: "tfs/c/p/_git/web", number: 7 };
    expect(pullRequestSyncKey(reference, identity, profiles)).toEqual(expected);
    expect(
      pullRequestSyncKey({ ...reference, host: "web.example.test" }, identity, profiles),
    ).toEqual(expected);
    expect(
      pullRequestSyncKey(
        { ...reference, host: "web.example.test", repository: "C/P/_git/Web" },
        undefined,
        profiles,
      ),
    ).toEqual(expected);
    expect(
      pullRequestSyncKey({ ...reference, host: "other.example.test" }, identity, profiles),
    ).toBeNull();
    expect(identity.provider).toBe("unknown");
  });
  it.each([
    "dev.azure.com/org/project/_git/web",
    "ssh.dev.azure.com/v3/org/project/web",
    "vs-ssh.visualstudio.com/v3/org/project/web",
    "org.visualstudio.com/defaultcollection/project/_git/web",
  ])("resolves hostless and checkout-host Azure references for %s", (canonicalKey) => {
    const identity = {
      canonicalKey,
      provider: "azure-devops",
      name: "web",
      displayName: canonicalKey.split("/").slice(1).join("/"),
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: `https://${canonicalKey}`,
      },
    };
    const expected = { host: "dev.azure.com", repository: "org/project/_git/web", number: 7 };
    expect(pullRequestSyncKey(reference, identity)).toEqual(expected);
    expect(
      pullRequestSyncKey({ ...reference, host: canonicalKey.split("/")[0]! }, identity),
    ).toEqual(expected);
    expect(pullRequestSyncKey({ ...reference, repository: "other" }, identity)).toBeNull();
    expect(pullRequestSyncKey({ ...reference, host: "unrelated.test" }, identity)).toBeNull();
  });
  it("normalizes complete hosted aliases without requiring a checkout", () => {
    expect(
      pullRequestSyncKey({
        ...reference,
        host: "org.visualstudio.com",
        repository: "project/_git/web",
      }),
    ).toEqual({ host: "dev.azure.com", repository: "org/project/_git/web", number: 7 });
    expect(
      pullRequestSyncKey({ ...reference, host: "github.com", repository: "acme/web" }),
    ).toEqual({ host: "github.com", repository: "acme/web", number: 7 });
    expect(pullRequestSyncKey(reference)).toBeNull();
  });
});
