import { describe, expect, it } from "vite-plus/test";

import {
  changeRequestRepositoryUrl,
  findProjectForChangeRequest,
  findProjectOnChangeRequestHost,
  gitHubPullRequestBrowserUrl,
  matchesLinkedPullRequestUrl,
  parseChangeRequestUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  shouldOpenPullRequestExternally,
  resolvePullRequestPreviewTarget,
} from "./openPullRequestLink";
import { EnvironmentId, ProjectId, type RepositoryIdentity } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";

describe("Server preview targets", () => {
  const environmentId = EnvironmentId.make("server-env");
  const profiles = [
    {
      apiCollectionUrl: "https://git.example.test:8443/tfs/C",
      browserCollectionUrl: "https://web.example.test/tfs/C",
    },
  ];
  const project: EnvironmentProject = {
    environmentId,
    id: ProjectId.make("selected-checkout"),
    title: "Repo",
    workspaceRoot: "/selected-checkout",
    repositoryIdentity: {
      ...repositoryIdentity(
        "unknown",
        "git.example.test:8443/tfs/c/p/_git/repo",
        "https://git.example.test:8443/tfs/C/P/_git/Repo",
      ),
      displayName: "tfs/C/P/_git/Repo",
      name: "Repo",
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
  };

  it.each(["https://web.example.test/tfs/C", "https://git.example.test:8443/tfs/C"])(
    "uses the list reference for %s",
    (collection) => {
      expect(
        resolvePullRequestPreviewTarget({
          environmentId,
          projects: [project],
          pullRequestsEnabled: true,
          profiles,
          url: `${collection}/P/_git/Repo/pullrequest/42`,
        }),
      ).toEqual({
        environmentId,
        input: {
          projectId: project.id,
          host: "git.example.test:8443",
          repository: "Repo",
          number: 42,
        },
      });
    },
  );

  const firstProject = { ...project, id: ProjectId.make("first-checkout") };
  const preferredProject = { environmentId, projectId: project.id };
  const preview = (
    url: string,
    preference = preferredProject,
    candidates = [firstProject, project],
  ) =>
    resolvePullRequestPreviewTarget({
      environmentId,
      projects: candidates,
      pullRequestsEnabled: true,
      profiles,
      url,
      preferredProject: preference,
    });

  it.each(["https://web.example.test/tfs/C", "https://git.example.test:8443/tfs/C"])(
    "prefers the selected checkout for a matching Server repository at %s",
    (collection) => {
      expect(preview(`${collection}/P/_git/Repo/pullrequest/42`)?.input.projectId).toBe(project.id);
    },
  );

  it("does not apply a project preference from another environment", () => {
    expect(
      preview("https://web.example.test/tfs/C/P/_git/Repo/pullrequest/42", {
        ...preferredProject,
        environmentId: EnvironmentId.make("another-env"),
      })?.input.projectId,
    ).toBe(firstProject.id);
  });

  it.each([
    "https://git.example.test:8443/tfs/C/P/_git/Other",
    "https://git.example.test:8443/tfs/Other/P/_git/Repo",
    "https://git.example.test:9443/tfs/C/P/_git/Repo",
  ])("ignores a preferred checkout with a different Server identity: %s", (remoteUrl) => {
    const otherProject = {
      ...project,
      repositoryIdentity: repositoryIdentity(
        "unknown",
        remoteUrl.slice("https://".length).toLowerCase(),
        remoteUrl,
      ),
    };
    expect(
      preview("https://web.example.test/tfs/C/P/_git/Repo/pullrequest/42", preferredProject, [
        firstProject,
        otherProject,
      ])?.input.projectId,
    ).toBe(firstProject.id);
  });

  it("preserves the existing first-checkout order for other providers", () => {
    const identity = {
      ...repositoryIdentity("github", "github.com/team/repo", "https://github.com/team/repo.git"),
      displayName: "team/repo",
    };
    expect(
      preview("https://github.com/team/repo/pull/42", preferredProject, [
        { ...firstProject, repositoryIdentity: identity },
        { ...project, repositoryIdentity: identity },
      ])?.input.projectId,
    ).toBe(firstProject.id);
  });
});

function repositoryIdentity(
  provider: string,
  canonicalKey: string,
  remoteUrl: string,
): RepositoryIdentity {
  return {
    canonicalKey,
    provider,
    locator: { source: "git-remote", remoteName: "origin", remoteUrl },
  };
}

describe("gitHubPullRequestBrowserUrl", () => {
  it("uses the requested GitHub repository instead of the project's default repository", () => {
    const identity = repositoryIdentity(
      "github",
      "github.com/acme/default",
      "https://github.com/acme/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "acme/other", 42)).toBe(
      "https://github.com/acme/other/pull/42",
    );
  });

  it("preserves a custom GitHub HTTP origin without its credentials", () => {
    const identity = repositoryIdentity(
      "github",
      "github.acme.test/team/default",
      "http://token@github.acme.test:8443/team/default.git",
    );

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 7)).toBe(
      "http://github.acme.test:8443/platform/api/pull/7",
    );
  });

  it.each([
    {
      name: "SSH",
      remoteUrl: "git@github.acme.test:team/default.git",
    },
    {
      name: "git protocol",
      remoteUrl: "git://github.acme.test/team/default.git",
    },
  ])("uses the normalized host for a $name remote", ({ remoteUrl }) => {
    const identity = repositoryIdentity("github", "github.acme.test/team/default", remoteUrl);

    expect(gitHubPullRequestBrowserUrl(identity, "platform/api", 9)).toBe(
      "https://github.acme.test/platform/api/pull/9",
    );
  });

  it("returns null for missing or invalid GitHub data", () => {
    expect(gitHubPullRequestBrowserUrl(null, "acme/repository", 1)).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "../repository",
        1,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "github.com/acme/repository", "https://github.com/a/b"),
        "acme/repository",
        0,
      ),
    ).toBeNull();
    expect(
      gitHubPullRequestBrowserUrl(
        repositoryIdentity("github", "bad host/acme/repository", "not a remote"),
        "acme/repository",
        1,
      ),
    ).toBeNull();
  });

  it.each(["gitlab", "bitbucket", "azure-devops", "unknown"])(
    "does not build a fallback for %s",
    (provider) => {
      expect(
        gitHubPullRequestBrowserUrl(
          repositoryIdentity(provider, "github.com/acme/repository", "https://github.com/a/b"),
          "acme/repository",
          1,
        ),
      ).toBeNull();
    },
  );
});

describe("changeRequestRepositoryUrl", () => {
  it("preserves repository path casing", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/Team/Platform/Repo/-/merge_requests/42/diffs#note_1",
      ),
    ).toBe("https://gitlab.example.test/Team/Platform/Repo");
  });

  it("keeps pull-like segments inside nested GitLab repository paths", () => {
    expect(
      changeRequestRepositoryUrl(
        "https://gitlab.example.test/group/pull/123/repo/-/merge_requests/42",
      ),
    ).toBe("https://gitlab.example.test/group/pull/123/repo");
  });
});

describe("pullRequestCandidateUrlFromReferenceAutolink", () => {
  it("turns GitHub's shared issue route into a pull request candidate", () => {
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://github.com/pingdotgg/t3code/issues/8600#issuecomment-1",
      ),
    ).toBe("https://github.com/pingdotgg/t3code/pull/8600#issuecomment-1");
  });

  it("does not reinterpret other issue hosts or malformed references", () => {
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://gitlab.com/pingdotgg/t3code/-/issues/8600",
      ),
    ).toBeNull();
    expect(
      pullRequestCandidateUrlFromReferenceAutolink(
        "https://github.com/pingdotgg/t3code/issues/not-a-number",
      ),
    ).toBeNull();
  });
});

describe("matchesLinkedPullRequestUrl", () => {
  const linkedPullRequest = {
    projectId: ProjectId.make("project-1"),
    repository: "pingdotgg/t3code",
    number: 42,
    url: "https://github.com/pingdotgg/t3code/pull/42",
  };

  it("matches the same pull request without looking up its project", () => {
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.com/PingDotGG/T3Code/pull/42/files",
      ),
    ).toBe(true);
  });

  it.each([
    ["http://forge.example:3000/git/team/repo/pulls/42/files", true],
    ["http://forge.example:4000/git/team/repo/pulls/42", false],
    ["http://forge.example/git/team/repo/pulls/42", false],
  ])("matches Forgejo links by web authority: %s", (url, expected) => {
    expect(
      matchesLinkedPullRequestUrl(
        { ...linkedPullRequest, url: "http://forge.example:3000/git/team/repo/pulls/42" },
        url,
      ),
    ).toBe(expected);
  });

  it("keeps other providers' existing port normalization", () => {
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.com:8443/pingdotgg/t3code/pull/42",
      ),
    ).toBe(true);
  });

  it("keeps Forgejo and GitHub path shapes distinct on a GitHub-named host", () => {
    expect(
      matchesLinkedPullRequestUrl(
        { ...linkedPullRequest, url: "https://github.internal/team/repo/pulls/42" },
        "https://github.internal/team/repo/pull/42",
      ),
    ).toBe(false);
  });

  it("rejects a different pull request or host", () => {
    expect(
      matchesLinkedPullRequestUrl(linkedPullRequest, "https://github.com/pingdotgg/t3code/pull/43"),
    ).toBe(false);
    expect(
      matchesLinkedPullRequestUrl(
        linkedPullRequest,
        "https://github.example.com/pingdotgg/t3code/pull/42",
      ),
    ).toBe(false);
  });
});

describe("shouldOpenPullRequestExternally", () => {
  it("uses the browser for command-click and control-click", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: true, ctrlKey: false })).toBe(true);
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: true })).toBe(true);
  });

  it("uses the browser for middle-click", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: false, button: 1 })).toBe(
      true,
    );
  });

  it("keeps an unmodified click in the pull request view", () => {
    expect(shouldOpenPullRequestExternally({ metaKey: false, ctrlKey: false })).toBe(false);
  });
});

describe("findProjectOnChangeRequestHost", () => {
  const project = (id: string, identity: Record<string, unknown>) =>
    ({
      id,
      repositoryIdentity: {
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://${String(identity.canonicalKey ?? "")}`,
        },
        ...identity,
      },
    }) as never;
  const frontend = project("frontend", {
    canonicalKey: "github.com/acme/frontend",
    provider: "github",
    owner: "acme",
    name: "frontend",
  });
  const backend = project("backend", {
    canonicalKey: "github.com/acme/backend",
    provider: "github",
    owner: "acme",
    name: "backend",
  });

  it.each([
    "ssh.dev.azure.com/v3/org-a/project/web",
    "vs-ssh.visualstudio.com/v3/org-a/project/web",
    "org-a.visualstudio.com/defaultcollection/project/_git/web",
    "dev.azure.com/org-a/project/_git/web",
  ])("matches Azure browser references against %s", (canonicalKey) => {
    const checkout = project("azure", {
      canonicalKey,
      provider: "azure-devops",
      displayName: canonicalKey.split("/").slice(1).join("/"),
    });
    const reference = { host: "dev.azure.com", repository: "org-a/project/_git/web", number: 42 };
    expect(findProjectForChangeRequest([checkout], reference)).toBe(checkout);
    expect(findProjectOnChangeRequestHost([checkout], reference)).toBe(checkout);
    expect(
      findProjectOnChangeRequestHost([checkout], {
        ...reference,
        repository: "org-b/project/_git/web",
      }),
    ).toBeUndefined();
    expect(
      findProjectOnChangeRequestHost([checkout], {
        ...reference,
        repository: "org-a/other-project/_git/web",
      }),
    ).toBeUndefined();
  });

  it("prefers the project checked out from the link's own repository", () => {
    expect(
      findProjectOnChangeRequestHost([frontend, backend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(backend);
  });

  it("selects the Forgejo HTTP port for repository and host-level matches", () => {
    const projects = [3000, 4000].map((port) =>
      project(`forgejo-${port}`, {
        canonicalKey: "forge.example/git/team/repo",
        provider: "forgejo",
        displayName: "git/team/repo",
        locator: { remoteUrl: `http://forge.example:${port}/git/team/repo.git` },
      }),
    );
    const reference = parseChangeRequestUrl("http://forge.example:4000/git/team/repo/pulls/42")!;
    expect(findProjectForChangeRequest(projects, reference)).toBe(projects[1]);
    expect(findProjectOnChangeRequestHost(projects, reference)).toBe(projects[1]);
    expect(
      findProjectOnChangeRequestHost(projects, { ...reference, repository: "git/team/other" }),
    ).toBe(projects[1]);
    expect(findProjectForChangeRequest([projects[0]!], reference)).toBeUndefined();
    expect(findProjectOnChangeRequestHost([projects[0]!], reference)).toBeUndefined();
  });

  it("lets tea resolve the web port for Forgejo SSH remotes", () => {
    const checkout = project("forgejo-ssh", {
      canonicalKey: "forge.example/git/team/repo",
      provider: "forgejo",
      displayName: "git/team/repo",
      locator: { remoteUrl: "git@forge.example:git/team/repo.git" },
    });
    const reference = parseChangeRequestUrl("http://forge.example:4000/git/team/repo/pulls/42")!;
    expect(findProjectForChangeRequest([checkout], reference)).toBe(checkout);
    const aliased = project("forgejo-alias", {
      canonicalKey: "ssh.forge.example/team/repo",
      provider: "forgejo",
      displayName: "team/repo",
      locator: { remoteUrl: "git@ssh.forge.example:team/repo.git" },
      webUrl: "http://forge.example:4000/git/team/repo",
    });
    expect(findProjectForChangeRequest([aliased], reference)).toBe(aliased);
    expect(findProjectOnChangeRequestHost([aliased], reference)).toBe(aliased);
    expect(
      findProjectOnChangeRequestHost([aliased], { ...reference, repository: "git/team/other" }),
    ).toBe(aliased);
    for (const url of [
      "http://other.example:4000/git/team/repo/pulls/42",
      "http://forge.example:3000/git/team/repo/pulls/42",
    ]) {
      const other = parseChangeRequestUrl(url)!;
      expect(findProjectForChangeRequest([aliased], other)).toBeUndefined();
      expect(findProjectOnChangeRequestHost([aliased], other)).toBeUndefined();
    }
    const otherMount = parseChangeRequestUrl("http://forge.example:4000/other/team/repo/pulls/42")!;
    expect(findProjectForChangeRequest([aliased], otherMount)).toBeUndefined();
    expect(findProjectOnChangeRequestHost([aliased], otherMount)).toBeUndefined();
  });

  it("lends any project on the host to a repository nobody has checked out", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "github.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBe(frontend);
  });

  it("finds nothing on a host nothing is checked out from", () => {
    expect(
      findProjectOnChangeRequestHost([frontend], {
        host: "gitlab.com",
        repository: "acme/backend",
        number: 7,
      }),
    ).toBeUndefined();
  });
});

describe("findProjectForChangeRequest", () => {
  const project = (identity: Record<string, unknown>) =>
    ({
      id: "p1",
      repositoryIdentity: {
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: `https://${String(identity.canonicalKey ?? "")}`,
        },
        ...identity,
      },
    }) as never;

  it("resolves configured Server browser aliases before host filtering and recovers unknown identities", () => {
    const profiles = [
      {
        apiCollectionUrl: "https://git.example.test:8443/tfs/C",
        browserCollectionUrl: "https://web.example.test/tfs/C",
      },
    ];
    const checkout = project(
      repositoryIdentity(
        "unknown",
        "git.example.test:8443/tfs/c/p/_git/repo",
        "https://git.example.test:8443/tfs/C/P/_git/Repo",
      ),
    );
    const reference = parseChangeRequestUrl(
      "https://web.example.test/tfs/C/P/_git/Repo/pullrequest/42",
    )!;
    expect(findProjectForChangeRequest([checkout], reference)).toBeUndefined();
    expect(findProjectForChangeRequest([checkout], reference, () => profiles)).toBe(checkout);
    expect(findProjectOnChangeRequestHost([checkout], reference, () => profiles)).toBe(checkout);
    expect(
      findProjectForChangeRequest(
        [checkout],
        { ...reference, repository: "tfs/Other/P/_git/Repo" },
        () => profiles,
      ),
    ).toBeUndefined();
  });

  it("matches a nested GitLab group by the whole path below the host", () => {
    const projects = [
      project({
        canonicalKey: "gitlab.com/t3tools/platform/t3code",
        provider: "gitlab",
        displayName: "t3tools/platform/t3code",
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "gitlab.com",
        repository: "t3tools/platform/t3code",
        number: 42,
      }),
    ).toBe(projects[0]);
  });

  it("keeps two hosts apart, so an Enterprise link does not open the public one", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.acme.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });

  it("matches an Azure repository cloned over SSH, whose remote shares no part with its URL", () => {
    // Azure alone addresses one repository under two names: `ssh.dev.azure.com` and `v3/...` over
    // SSH against `dev.azure.com` and `.../_git/...` everywhere a person sees it. The identity is
    // recorded in the spelling a link arrives in, so both halves of this comparison line up.
    const canonicalKey = normalizeGitRemoteUrl("git@ssh.dev.azure.com:v3/T3Tools/Platform/T3Code");
    const projects = [
      project({
        canonicalKey,
        provider: "azure-devops",
        displayName: canonicalKey.split("/").slice(1).join("/"),
        owner: "t3tools",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "dev.azure.com",
        repository: "t3tools/platform/_git/t3code",
        number: 1,
      }),
    ).toBe(projects[0]);
  });

  it("claims nothing for a lookalike host, which is what keeps a link a link", () => {
    const projects = [
      project({
        canonicalKey: "github.com/pingdotgg/t3code",
        provider: "github",
        owner: "pingdotgg",
        name: "t3code",
      }),
    ];
    expect(
      findProjectForChangeRequest(projects, {
        host: "github.com-evil.test",
        repository: "pingdotgg/t3code",
        number: 1,
      }),
    ).toBeUndefined();
  });
});
