import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PullRequestRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { detail, readThreadShell } = vi.hoisted(() => ({
  detail: vi.fn((request: { environmentId: EnvironmentId; input: PullRequestRef }) => request),
  readThreadShell: vi.fn(),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => serverConfig }));
vi.mock("~/state/entities", () => ({
  readThreadShell,
  useThreadShell: (ref: ScopedThreadRef | null) => (ref ? readThreadShell(ref) : null),
  useProjects: () => projects,
  useServerConfigs: () => new Map([[environmentId, serverConfig]]),
}));
vi.mock("~/state/environments", () => ({ usePrimaryEnvironmentId: () => environmentId }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => vi.fn() }));
vi.mock("~/state/pullRequests", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/state/pullRequests")>();
  return { ...actual, pullRequestEnvironment: { ...actual.pullRequestEnvironment, detail } };
});
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (query: ReturnType<typeof detail> | null) => ({
    data: query
      ? {
          repository: query.input.repository,
          number: query.input.number,
          title: `Read with ${query.input.projectId}`,
          state: "open",
          isDraft: false,
          author: { login: "reader", name: "Reader", avatarUrl: null },
          createdAt: "2026-10-17T00:00:00Z",
        }
      : null,
    error: null,
  }),
}));
vi.mock("./ui/preview-card", () => ({
  PreviewCard: ({
    children,
    onOpenChange,
  }: {
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => <div onPointerEnter={() => onOpenChange(true)}>{children}</div>,
  PreviewCardTrigger: ({ render }: { render: ReactNode }) => render,
  PreviewCardPopup: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});

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
const serverConfig = {
  environment: { capabilities: { pullRequests: true, threadPullRequests: true } },
  settings: { sourceControlHosts: { "azure-devops-server": { profiles } } },
};
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
let projects: ReadonlyArray<EnvironmentProject>;
let renderer: ReactTestRenderer;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  projects = [
    { ...selectedProject, environmentId: otherEnvironmentId },
    firstProject,
    selectedProject,
  ];
  readThreadShell.mockReset().mockReturnValue({ projectId: selectedProject.id });
  detail.mockClear();
  useRightPanelStore.setState({ byThreadKey: {} });
});
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
});

function reference(projectId = selectedProject.id) {
  return { projectId, host: "git.example.test:8443", repository: "Repo", number: 42 };
}
function hover() {
  const trigger = renderer.root.findAllByType("div").find((node) => node.props.onPointerEnter);
  expect(trigger, "a native PR detail is available").toBeDefined();
  act(() => trigger!.props.onPointerEnter());
}
function expectPreview(projectId = selectedProject.id) {
  expect(detail).toHaveBeenLastCalledWith({ environmentId, input: reference(projectId) });
  expect(
    renderer.root
      .findByType("aside")
      .findAllByType("p")
      .map((node) => node.children.join("")),
  ).toContain(`Read with ${projectId}`);
}

describe("rendered Server pull request previews", () => {
  it.each([webUrl, apiUrl])("reads %s through the thread's selected checkout", async (url) => {
    await act(async () => {
      renderer = create(
        <ChatMarkdown cwd="/selected-checkout" threadRef={threadRef} text={`[PR](${url})`} />,
      );
    });
    expect(detail).not.toHaveBeenCalled();
    hover();
    expectPreview();
  });

  it("follows the standalone panel's selected checkout when its selection changes", async () => {
    useRightPanelStore.getState().openPullRequest(pageRef, { ...reference(), environmentId });
    await act(async () => {
      renderer = create(
        <ChatMarkdown
          cwd={undefined}
          environmentId={environmentId}
          pullRequestPanelRef={pageRef}
          text={`[PR](${webUrl})`}
        />,
      );
    });
    hover();
    expectPreview();
    act(() =>
      useRightPanelStore
        .getState()
        .openPullRequest(pageRef, { ...reference(firstProject.id), environmentId }),
    );
    expectPreview(firstProject.id);
  });

  it("reads a context chip through the same selected checkout", async () => {
    await act(async () => {
      renderer = create(
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
    hover();
    expectPreview();
  });

  it("does not borrow a thread checkout from another environment", async () => {
    await act(async () => {
      renderer = create(
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
    hover();
    expectPreview(firstProject.id);
  });

  it.each([
    "https://git.example.test:9443/tfs/C/P/_git/Repo/pullrequest/42",
    "https://web.example.test/tfs/Other/P/_git/Repo/pullrequest/42",
    "https://web.example.test/tfs/C/P/_git/Other/pullrequest/42",
  ])("keeps an unmatched link ordinary: %s", async (url) => {
    await act(async () => {
      renderer = create(
        <ChatMarkdown cwd="/selected-checkout" threadRef={threadRef} text={`[PR](${url})`} />,
      );
    });
    expect(
      renderer.root.findAllByType("div").filter((node) => node.props.onPointerEnter),
    ).toHaveLength(0);
    expect(detail).not.toHaveBeenCalled();
  });
});
