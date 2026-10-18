import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  ThreadId,
  type PullRequestDetailView,
  type ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("@tanstack/react-router"), { spy: true });
vi.mock(import("~/state/entities"), { spy: true });
vi.mock(import("~/state/environments"), { spy: true });

import { useNavigate } from "@tanstack/react-router";
import * as entities from "~/state/entities";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { pullRequestEnvironment } from "~/state/pullRequests";
import { environmentServerConfigsAtom, serverEnvironment } from "~/state/server";

import ChatMarkdown from "./ChatMarkdown";
import { PullRequestChip } from "./contextChipParts";
import {
  ComposerContextActionsContext,
  ComposerContextRecordsContext,
  ComposerContextReferenceChip,
} from "./composerContextPresentation";
import { useRightPanelStore } from "~/rightPanelStore";

const environmentId = EnvironmentId.make("server-env");
const otherEnvironmentId = EnvironmentId.make("other-env");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
const pageRef = { environmentId: EnvironmentId.make("page"), threadId: ThreadId.make("page") };
const profiles = [
  {
    apiCollectionUrl: "https://git.example.test:8443/tfs/C",
    browserCollectionUrl: "https://web.example.test/tfs/C",
  },
];
const serverConfig: ServerConfig = {
  environment: {
    environmentId,
    label: "Server",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: true, pullRequests: true, threadPullRequests: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test-session",
  },
  cwd: "/selected-checkout",
  keybindingsConfigPath: "/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: {
    ...DEFAULT_SERVER_SETTINGS,
    sourceControlHosts: { "azure-devops-server": { profiles } },
  },
};
const configAtom = Atom.make<ServerConfig | null>(serverConfig);
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
const webUrl = "https://web.example.test/tfs/C/P/_git/Repo/pullrequest/42";
const apiUrl = "https://git.example.test:8443/tfs/C/P/_git/Repo/pullrequest/42";
const detail = vi.fn<typeof pullRequestEnvironment.detail>();
const readThreadShell = vi.fn();
let projects: ReadonlyArray<EnvironmentProject>;
let registry: AtomRegistry.AtomRegistry;
let root: Root | undefined;
let container: HTMLDivElement;
function render(children: ReactNode) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  root.render(<RegistryContext.Provider value={registry}>{children}</RegistryContext.Provider>);
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  projects = [
    { ...selectedProject, environmentId: otherEnvironmentId },
    firstProject,
    selectedProject,
  ];
  readThreadShell.mockReset().mockReturnValue({ projectId: selectedProject.id });
  vi.mocked(useNavigate).mockReturnValue(vi.fn());
  vi.mocked(entities.useProjects).mockImplementation(() => projects);
  vi.mocked(entities.readThreadShell).mockImplementation(readThreadShell);
  vi.mocked(entities.useThreadShell).mockImplementation((ref) =>
    ref ? readThreadShell(ref) : null,
  );
  vi.mocked(usePrimaryEnvironmentId).mockReturnValue(environmentId);
  vi.spyOn(serverEnvironment, "configValueAtom").mockReturnValue(configAtom);
  registry = AtomRegistry.make({
    initialValues: [[environmentServerConfigsAtom, new Map([[environmentId, serverConfig]])]],
  });
  const detailAtoms = new Map<ProjectId, ReturnType<typeof pullRequestEnvironment.detail>>();
  detail.mockReset().mockImplementation(({ input }) => {
    let atom = detailAtoms.get(input.projectId);
    if (!atom) {
      const project = projects.find((candidate) => candidate.id === input.projectId)!;
      const value: PullRequestDetailView = {
        provider: SourceControlProviderKind.make("azure-devops-server"),
        projectId: input.projectId,
        projectTitle: project.title,
        workspaceRoot: project.workspaceRoot,
        repository: input.repository,
        number: input.number,
        title: `Read with ${input.projectId}`,
        body: "",
        url: webUrl,
        state: "open",
        isDraft: false,
        author: { login: "reader", name: "Reader", avatarUrl: null },
        viewer: "reader",
        mergeability: "unknown",
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        headBranch: "feature",
        baseBranch: "main",
        createdAt: "2026-10-17T00:00:00Z",
        updatedAt: "2026-10-17T00:00:00Z",
        mergedAt: null,
        closedAt: null,
        reviewers: [],
        labels: [],
        checks: [],
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
        mergeCapabilities: { merge: false, squash: false, rebase: false },
        capabilities: {
          diff: true,
          comment: false,
          search: true,
          actions: [],
          mergeMethods: [],
          review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
          reviewers: { request: false, listCandidates: false },
          edit: { changeRequest: false, comment: false },
        },
        viewerPermissions: {
          actions: [],
          comment: false,
          resolve: false,
          verdicts: [],
          requestReviewers: false,
        },
      };
      atom = Atom.make<Atom.Type<ReturnType<typeof pullRequestEnvironment.detail>>>(
        AsyncResult.success(value),
      );
      detailAtoms.set(input.projectId, atom);
    }
    return atom;
  });
  vi.spyOn(pullRequestEnvironment, "detail").mockImplementation(detail);
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  registry.dispose();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function reference(projectId = selectedProject.id) {
  return { projectId, host: "git.example.test:8443", repository: "Repo", number: 42 };
}
async function hover() {
  const trigger = container.querySelector<HTMLElement>('[data-slot="preview-card-trigger"]');
  expect(trigger, "a native PR detail is available").not.toBeNull();
  await page.elementLocator(trigger!).hover();
}
async function expectPreview(projectId = selectedProject.id) {
  await expect.element(page.getByText(`Read with ${projectId}`, { exact: true })).toBeVisible();
  expect(detail).toHaveBeenLastCalledWith({ environmentId, input: reference(projectId) });
}

describe("rendered Server pull request previews", () => {
  it.each([webUrl, apiUrl])("reads %s through the thread's selected checkout", async (url) => {
    await act(async () => {
      render(<ChatMarkdown cwd="/selected-checkout" threadRef={threadRef} text={`[PR](${url})`} />);
    });
    expect(detail).not.toHaveBeenCalled();
    await hover();
    await expectPreview();
  });

  it("follows the standalone panel's selected checkout when its selection changes", async () => {
    useRightPanelStore.getState().openPullRequest(pageRef, { ...reference(), environmentId });
    await act(async () => {
      render(
        <ChatMarkdown
          cwd={undefined}
          environmentId={environmentId}
          pullRequestPanelRef={pageRef}
          text={`[PR](${webUrl})`}
        />,
      );
    });
    await hover();
    await expectPreview();
    await act(async () =>
      useRightPanelStore
        .getState()
        .openPullRequest(pageRef, { ...reference(firstProject.id), environmentId }),
    );
    await expectPreview(firstProject.id);
  });

  it("updates native previews when the configured browser alias changes", async () => {
    const nextUrl = "https://new-web.example.test/tfs/C/P/_git/Repo/pullrequest/42";
    await act(async () => {
      render(
        <ChatMarkdown
          cwd="/selected-checkout"
          threadRef={threadRef}
          text={`[Old PR](${webUrl}) and [New PR](${nextUrl})`}
        />,
      );
    });
    expect(container.querySelector('[data-slot="preview-card-trigger"]')?.textContent).toBe(
      "Old PR",
    );
    await act(async () => {
      registry.set(configAtom, {
        ...serverConfig,
        settings: {
          ...serverConfig.settings,
          sourceControlHosts: {
            "azure-devops-server": {
              profiles: [
                { ...profiles[0]!, browserCollectionUrl: "https://new-web.example.test/tfs/C" },
              ],
            },
          },
        },
      });
    });
    expect(
      [...container.querySelectorAll('[data-slot="preview-card-trigger"]')].map(
        (node) => node.textContent,
      ),
    ).toEqual(["New PR"]);
    await hover();
    await expectPreview();
  });

  it("reads a context chip through the same selected checkout", async () => {
    await act(async () => {
      render(
        <ComposerContextActionsContext
          value={{
            environmentId,
            threadRef,
            expandImage() {},
            expandVideo() {},
            openFile() {},
            openMention() {},
            openPullRequest() {},
          }}
        >
          <ComposerContextRecordsContext
            value={
              new Map([
                [
                  "pr-42",
                  {
                    kind: "review-comment",
                    record: {
                      id: "pr-42",
                      sectionId: "pull-request:42",
                      sectionTitle: "PR",
                      filePath: "PR #42",
                      startIndex: 0,
                      endIndex: 0,
                      rangeLabel: "",
                      text: "",
                      diff: "",
                      pullRequest: {
                        number: 42,
                        title: "PR",
                        url: webUrl,
                        headBranch: "feature",
                        baseBranch: "main",
                        state: "open",
                        isDraft: false,
                      },
                    },
                  },
                ],
              ])
            }
          >
            <ComposerContextReferenceChip contextId="pr-42" kind="review-comment" label="#42" />
          </ComposerContextRecordsContext>
        </ComposerContextActionsContext>,
      );
    });
    await hover();
    await expectPreview();
  });

  it("does not borrow a thread checkout from another environment", async () => {
    await act(async () => {
      render(
        <PullRequestChip
          environmentId={environmentId}
          threadRef={{ ...threadRef, environmentId: otherEnvironmentId }}
          metadata={{
            number: 42,
            title: "PR",
            url: webUrl,
            headBranch: "feature",
            baseBranch: "main",
            state: "open",
            isDraft: false,
          }}
          label="#42"
          kindLabel="Pull request"
          kind="pr-open"
          onOpen={() => {}}
        />,
      );
    });
    await hover();
    await expectPreview(firstProject.id);
  });

  it.each([
    "https://git.example.test:9443/tfs/C/P/_git/Repo/pullrequest/42",
    "https://web.example.test/tfs/Other/P/_git/Repo/pullrequest/42",
    "https://web.example.test/tfs/C/P/_git/Other/pullrequest/42",
  ])("keeps an unmatched link ordinary: %s", async (url) => {
    await act(async () => {
      render(<ChatMarkdown cwd="/selected-checkout" threadRef={threadRef} text={`[PR](${url})`} />);
    });
    expect(container.querySelector('[data-slot="preview-card-trigger"]')).toBeNull();
    expect(container.querySelector("a")?.getAttribute("href")).toBe(url);
    expect(detail).not.toHaveBeenCalled();
  });
});
