import { SourceControlProviderKind } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, useEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { navigate, readThreadShell } = vi.hoisted(() => ({
  navigate: vi.fn(),
  readThreadShell: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("~/state/entities", () => ({
  useProjects: () => projects,
  useServerConfigs: () =>
    new Map(
      projects.map((project) => [
        project.environmentId,
        {
          environment: { capabilities: { pullRequests: true, threadPullRequests: true } },
          settings: { sourceControlHosts: { "azure-devops-server": { profiles } } },
        },
      ]),
    ),
  readThreadShell,
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => environmentId }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentServerConfigsAtom } from "~/state/server";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { useOpenChangeRequestLink } from "./openPullRequestLink";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

const environmentId = EnvironmentId.make("server-env");
const otherEnvironmentId = EnvironmentId.make("other-env");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
const pageRef = {
  environmentId: EnvironmentId.make("pull-requests-page"),
  threadId: ThreadId.make("page"),
};
const profiles = [
  {
    apiCollectionUrl: "https://git.example.test:8443/tfs/C",
    browserCollectionUrl: "https://web.example.test/tfs/C",
  },
];
const url = "https://web.example.test/tfs/C/P/_git/Repo/pullrequest/42";
const firstProject: EnvironmentProject = {
  environmentId,
  id: ProjectId.make("first-checkout"),
  title: "Repo",
  workspaceRoot: "/first-checkout",
  repositoryIdentity: {
    canonicalKey: "git.example.test:8443/tfs/c/p/_git/repo",
    provider: SourceControlProviderKind.make("unknown"),
    displayName: "tfs/C/P/_git/Repo",
    name: "Repo",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://git.example.test:8443/tfs/C/P/_git/Repo",
    },
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
};
const selectedProject = {
  ...firstProject,
  id: ProjectId.make("selected-checkout"),
  workspaceRoot: "/selected-checkout",
};
let projects: ReadonlyArray<EnvironmentProject>;
let renderer: ReactTestRenderer;
let openLink: ReturnType<typeof useOpenChangeRequestLink>;
function Link({ thread, panel }: { thread?: ScopedThreadRef; panel?: ScopedThreadRef }) {
  const open = useOpenChangeRequestLink(thread, panel);
  useEffect(() => {
    openLink = open;
  }, [open]);
  return null;
}

beforeEach(() => {
  const original = appAtomRegistry.get.bind(appAtomRegistry);
  vi.spyOn(appAtomRegistry, "get").mockImplementation((atom) =>
    atom === environmentServerConfigsAtom
      ? (new Map(
          projects.map((project) => [
            project.environmentId,
            {
              environment: { capabilities: { pullRequests: true, threadPullRequests: true } },
              settings: {
                ...DEFAULT_SERVER_SETTINGS,
                sourceControlHosts: { "azure-devops-server": { profiles } },
              },
            },
          ]),
        ) as ReturnType<typeof original>)
      : original(atom),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  projects = [
    { ...firstProject, environmentId: otherEnvironmentId },
    firstProject,
    selectedProject,
  ];
  readThreadShell.mockReset().mockReturnValue(null);
  navigate.mockReset();
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});
function follow(target = url, targetEnvironmentId?: EnvironmentId) {
  return openLink(
    { metaKey: false, ctrlKey: false, preventDefault() {}, stopPropagation() {} },
    target,
    undefined,
    targetEnvironmentId,
  );
}
function reference(projectId = selectedProject.id) {
  return { projectId, host: "git.example.test:8443", repository: "Repo", number: 42 };
}

describe("configured Server link navigation", () => {
  it("reuses the list panel and keeps the thread's checkout in its environment", async () => {
    readThreadShell.mockReturnValue({ projectId: selectedProject.id });
    useRightPanelStore.getState().openPullRequest(threadRef, reference());
    await act(async () => {
      renderer = create(<Link thread={threadRef} />);
    });
    expect(follow()).toBe(true);
    expect(follow("https://git.example.test:8443/tfs/C/P/_git/Repo/pullrequest/42")).toBe(true);
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(panel.surfaces).toHaveLength(1);
    expect(panel.surfaces[0]).toMatchObject(reference());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a standalone panel's selected checkout and canonical navigation search", async () => {
    useRightPanelStore.getState().openPullRequest(pageRef, { ...reference(), environmentId });
    await act(async () => {
      renderer = create(<Link panel={pageRef} />);
    });
    expect(follow()).toBe(true);
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, pageRef);
    expect(panel.surfaces).toHaveLength(1);
    expect(panel.surfaces[0]).toMatchObject({ ...reference(), environmentId });
    const navigation = navigate.mock.calls[0]?.[0];
    expect(navigation.search({})).toMatchObject({
      selectedEnvironmentId: environmentId,
      selectedProjectId: selectedProject.id,
      selectedHost: "git.example.test:8443",
      repository: "Repo",
      number: 42,
    });
  });

  it("uses the explicitly requested environment for page navigation", async () => {
    await act(async () => {
      renderer = create(<Link />);
    });
    expect(follow(url, otherEnvironmentId)).toBe(true);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.objectContaining({
          selectedEnvironmentId: otherEnvironmentId,
          selectedProjectId: firstProject.id,
          selectedHost: "git.example.test:8443",
          repository: "Repo",
          number: 42,
        }),
      }),
    );
  });

  it.each([
    "https://git.example.test:9443/tfs/C/P/_git/Repo/pullrequest/42",
    "https://web.example.test/tfs/Other/P/_git/Repo/pullrequest/42",
  ])("does not match another collection or port: %s", async (otherUrl) => {
    await act(async () => {
      renderer = create(<Link thread={threadRef} />);
    });
    expect(follow(otherUrl)).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toHaveLength(0);
  });
});
