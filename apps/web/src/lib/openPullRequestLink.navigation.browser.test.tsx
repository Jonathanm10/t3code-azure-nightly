import { SourceControlProviderKind } from "@t3tools/contracts";
import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const { navigate, readThreadShell } = vi.hoisted(() => ({
  navigate: vi.fn(),
  readThreadShell: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), { spy: true });
vi.mock(import("~/state/entities"), { spy: true });
vi.mock(import("~/state/environments"), { spy: true });
vi.mock(import("~/browser/useOpenLink"), { spy: true });

import { useNavigate } from "@tanstack/react-router";
import * as entities from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useOpenLink } from "~/browser/useOpenLink";

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
type LinkContext = { thread?: ScopedThreadRef; panel?: ScopedThreadRef };
let root: Root;
let context: LinkContext;
let opened: boolean;
function Link({
  thread,
  panel,
  targetUrl = url,
  targetEnvironmentId,
}: LinkContext & { targetUrl?: string; targetEnvironmentId?: EnvironmentId | undefined }) {
  const open = useOpenChangeRequestLink(thread, panel);
  return (
    <button
      type="button"
      onClick={(event) => {
        opened = open(event, targetUrl, undefined, targetEnvironmentId);
      }}
    >
      Open pull request
    </button>
  );
}
async function renderLink(props: LinkContext = {}) {
  context = props;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<Link {...props} />));
}

beforeEach(() => {
  vi.mocked(useNavigate).mockReturnValue(navigate);
  vi.mocked(entities.useProjects).mockImplementation(() => projects);
  vi.mocked(entities.readThreadShell).mockImplementation(readThreadShell);
  vi.mocked(entities.useThreadShell).mockImplementation((ref) =>
    ref ? readThreadShell(ref) : null,
  );
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  vi.mocked(useOpenLink).mockReturnValue(vi.fn());
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
  opened = false;
  projects = [
    { ...firstProject, environmentId: otherEnvironmentId },
    firstProject,
    selectedProject,
  ];
  readThreadShell.mockReset().mockReturnValue(null);
  navigate.mockReset();
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function follow(target = url, targetEnvironmentId?: EnvironmentId) {
  await act(async () =>
    root.render(<Link {...context} targetUrl={target} targetEnvironmentId={targetEnvironmentId} />),
  );
  await page.getByRole("button", { name: "Open pull request", exact: true }).click();
  return opened;
}
function reference(projectId = selectedProject.id) {
  return { projectId, host: "git.example.test:8443", repository: "Repo", number: 42 };
}

describe("configured Server link navigation", () => {
  it("reuses the list panel and keeps the thread's checkout in its environment", async () => {
    readThreadShell.mockReturnValue({ projectId: selectedProject.id });
    useRightPanelStore.getState().openPullRequest(threadRef, reference());
    await renderLink({ thread: threadRef });
    expect(await follow()).toBe(true);
    expect(await follow("https://git.example.test:8443/tfs/C/P/_git/Repo/pullrequest/42")).toBe(
      true,
    );
    const panel = selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef);
    expect(panel.surfaces).toHaveLength(1);
    expect(panel.surfaces[0]).toMatchObject(reference());
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps a standalone panel's selected checkout and canonical navigation search", async () => {
    useRightPanelStore.getState().openPullRequest(pageRef, { ...reference(), environmentId });
    await renderLink({ panel: pageRef });
    expect(await follow()).toBe(true);
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
    await renderLink();
    expect(await follow(url, otherEnvironmentId)).toBe(true);
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
    await renderLink({ thread: threadRef });
    expect(await follow(otherUrl)).toBe(false);
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toHaveLength(0);
  });
});
