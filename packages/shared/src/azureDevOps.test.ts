import { azureDevOpsServerProfiles } from "./azureDevOps.ts";
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { AzureDevOpsServerProfiles, DEFAULT_SERVER_SETTINGS, ProjectId } from "@t3tools/contracts";
import { resolveAzureDevOpsServerAddress } from "./azureDevOps.ts";
import { parseChangeRequestUrl, matchesLinkedPullRequestUrl } from "./changeRequestUrl.ts";
import {
  detectSourceControlProviderFromRemoteUrl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const profiles = [
  {
    apiCollectionUrl: "https://git.example.test:8443/tfs/Collection",
    browserCollectionUrl: "https://web.example.test/tfs/Collection",
  },
];

describe("configured Azure DevOps Server collections", () => {
  it("preserves collection prefixes, ports and request spelling while canonicalizing browser aliases", () => {
    const remote = resolveAzureDevOpsServerAddress(
      "https://git.example.test:8443/tfs/Collection/Project%20One/_git/MyRepo",
      profiles,
    );
    const browser = resolveAzureDevOpsServerAddress(
      "https://web.example.test/tfs/Collection/Project%20One/_git/MyRepo/pullrequest/42?view=files",
      profiles,
    );
    expect(remote?.project).toBe("Project One");
    expect(remote?.apiCollectionUrl).toBe(profiles[0]?.apiCollectionUrl);
    expect(remote?.canonicalKey).toBe(browser?.canonicalKey);
    expect(remote?.browserRepositoryUrl).toBe(
      "https://web.example.test/tfs/Collection/Project%20One/_git/MyRepo",
    );
    expect(browser?.number).toBe(42);
  });

  it("requires explicit profiles and respects segment and origin boundaries", () => {
    for (const value of [
      "https://git.example.test:8443/tfs/Collection2/P/_git/R",
      "https://git.example.test/tfs/Collection/P/_git/R",
      "https://git.example.test:8443/tfs/Collection/P%2fQ/_git/R",
      "https://user:secret@git.example.test:8443/tfs/Collection/P/_git/R",
    ]) {
      expect(resolveAzureDevOpsServerAddress(value, profiles)).toBeNull();
    }
    expect(
      detectSourceControlProviderFromRemoteUrl(
        "https://git.example.test:8443/tfs/Collection/P/_git/R",
      )?.kind,
    ).toBe("unknown");
    const configured = detectSourceControlProviderFromRemoteUrl(
      "https://git.example.test:8443/tfs/Collection/P/_git/R",
      profiles,
    );
    expect(configured?.kind).toBe("azure-devops-server");
    expect(resolveChangeRequestPresentation(configured).checkoutCommandExample).toBeUndefined();
  });

  it("rejects ambiguous and credential-bearing profile settings", () => {
    const decode = Schema.decodeUnknownOption(AzureDevOpsServerProfiles);
    expect(
      decode([
        ...profiles,
        { apiCollectionUrl: "https://git.example.test:8443/tfs/Collection/nested" },
      ])._tag,
    ).toBe("None");
    for (const value of [
      "http://git.example.test/C",
      "https://user:secret@git.example.test/C",
      "https://git.example.test/C?token=secret",
      "https://git.example.test/C/P/_git/R",
    ])
      expect(decode([{ apiCollectionUrl: value }])._tag).toBe("None");
  });

  it("persists replacements and removals through the existing settings patch", () => {
    expect(azureDevOpsServerProfiles(DEFAULT_SERVER_SETTINGS)).toEqual([]);
    const configured = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      sourceControlHosts: { "azure-devops-server": { profiles } },
    });
    expect(azureDevOpsServerProfiles(configured)).toEqual(profiles);
    expect(
      azureDevOpsServerProfiles(
        applyServerSettingsPatch(configured, {
          sourceControlHosts: { "azure-devops-server": { profiles: [] } },
        }),
      ),
    ).toEqual([]);
  });

  it("matches native pull request links across configured API and browser origins", () => {
    const api = "https://git.example.test:8443/tfs/Collection/P/_git/R/pullrequest/42";
    const browser = "https://web.example.test/tfs/Collection/P/_git/R/pullrequest/42";
    expect(parseChangeRequestUrl(api, profiles)).toEqual(parseChangeRequestUrl(browser, profiles));
    expect(
      matchesLinkedPullRequestUrl(
        {
          url: api,
          number: 42,
          repository: "R",
          projectId: ProjectId.make("p"),
        },
        browser,
        profiles,
      ),
    ).toBe(true);
  });
});
