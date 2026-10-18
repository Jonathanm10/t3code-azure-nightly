import type {
  AzureDevOpsServerProfile,
  PullRequestRef,
  ScopedProjectRef,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  azureDevOpsServerProfiles,
  resolveAzureDevOpsServerAddress,
} from "@t3tools/shared/azureDevOps";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { type MouseEvent } from "react";

import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { parseChangeRequestUrl, type ChangeRequestLink } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";

import { useOpenLink } from "../browser/useOpenLink";
import { useClientSettings } from "../hooks/useSettings";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "../rightPanelStore";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShell, useProjects, useThreadShell } from "../state/entities";
import { environmentServerConfigsAtom, serverEnvironment } from "../state/server";
import { usePrimaryEnvironmentId } from "../state/environments";

export {
  parseChangeRequestUrl,
  type ChangeRequestLink,
  gitHubPullRequestBrowserUrl,
  pullRequestCandidateUrlFromReferenceAutolink,
  matchesLinkedPullRequestUrl,
  changeRequestRepositoryUrl,
} from "@t3tools/shared/changeRequestUrl";

export function findProjectForChangeRequest(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
  profilesForEnvironment?: (id: EnvironmentId) => ReadonlyArray<AzureDevOpsServerProfile>,
  preferredProjectRef?: ScopedProjectRef,
): EnvironmentProject | undefined {
  const preferredProject = preferredProjectRef
    ? projects.find(
        (project) =>
          project.id === preferredProjectRef.projectId &&
          project.environmentId === preferredProjectRef.environmentId,
      )
    : undefined;
  if (
    preferredProject &&
    serverPullRequestReference(
      preferredProject,
      link,
      profilesForEnvironment?.(preferredProject.environmentId) ?? [],
    ) !== null
  )
    return preferredProject;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    if (!identity) return false;
    const profiles = profilesForEnvironment?.(project.environmentId) ?? [];
    const server = resolveAzureDevOpsServerAddress(identity.locator.remoteUrl, profiles);
    if (server !== null)
      return (
        server.canonicalKey ===
        resolveAzureDevOpsServerAddress(
          `https://${link.authority ?? link.host}/${link.repository}`,
          profiles,
        )?.canonicalKey
      );
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).isChangeRequestInRepository(identity, link)
    );
  });
}

export function resolvePullRequestPreviewTarget({
  environmentId,
  projects,
  pullRequestsEnabled,
  url,
  profiles = [],
  preferredProject,
}: {
  environmentId: EnvironmentId | null;
  projects: ReadonlyArray<EnvironmentProject>;
  pullRequestsEnabled: boolean;
  url: string;
  profiles?: ReadonlyArray<AzureDevOpsServerProfile>;
  preferredProject?: ScopedProjectRef | undefined;
}): { environmentId: EnvironmentId; input: PullRequestRef } | null {
  if (!pullRequestsEnabled || environmentId === null) return null;
  const parsed = parseChangeRequestUrl(url, profiles);
  if (parsed === null) return null;
  const project = findProjectForChangeRequest(
    projects.filter((candidate) => candidate.environmentId === environmentId),
    parsed,
    () => profiles,
    preferredProject,
  );
  if (project === undefined) return null;
  return {
    environmentId,
    input: serverPullRequestReference(project, parsed, profiles) ?? {
      projectId: project.id,
      host: parsed.authority ?? parsed.host,
      repository: sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository,
      number: parsed.number,
    },
  };
}

function serverPullRequestReference(
  project: EnvironmentProject,
  link: ChangeRequestLink,
  profiles: ReadonlyArray<AzureDevOpsServerProfile>,
): PullRequestRef | null {
  const checkout = resolveAzureDevOpsServerAddress(
    project.repositoryIdentity?.locator.remoteUrl ?? "",
    profiles,
  );
  const target = resolveAzureDevOpsServerAddress(
    `https://${link.authority ?? link.host}/${link.repository}`,
    profiles,
  );
  if (checkout === null || target?.canonicalKey !== checkout.canonicalKey) return null;
  return {
    projectId: project.id,
    host: checkout.host,
    repository: checkout.repository,
    number: link.number,
  };
}

export function usePreferredPullRequestProject(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): ScopedProjectRef | undefined {
  const threadProjectId = useThreadShell(threadRef ?? null)?.projectId;
  const resolvedPanelRef = panelRef ?? threadRef;
  const selectedSurface = useRightPanelStore((state) =>
    selectSelectedRightPanelSurface(state.byThreadKey, resolvedPanelRef),
  );
  if (threadRef && threadProjectId !== undefined)
    return { environmentId: threadRef.environmentId, projectId: threadProjectId };
  if (selectedSurface?.kind !== "pull-request") return undefined;
  const environmentId = selectedSurface.environmentId ?? resolvedPanelRef?.environmentId;
  return environmentId === undefined
    ? undefined
    : {
        environmentId: EnvironmentId.make(environmentId),
        projectId: ProjectId.make(selectedSurface.projectId),
      };
}

export function usePullRequestPreviewTarget(
  environmentId: EnvironmentId | null,
  url: string,
  threadRef?: ScopedThreadRef,
) {
  const projects = useProjects();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const preferredProject = usePreferredPullRequestProject(threadRef);
  return resolvePullRequestPreviewTarget({
    environmentId,
    projects,
    pullRequestsEnabled: serverConfig?.environment.capabilities.pullRequests === true,
    url,
    profiles:
      serverConfig === null || serverConfig === undefined
        ? []
        : azureDevOpsServerProfiles(serverConfig.settings),
    preferredProject,
  });
}

export function findProjectOnChangeRequestHost(
  projects: ReadonlyArray<EnvironmentProject>,
  link: ChangeRequestLink,
  profilesForEnvironment?: (id: EnvironmentId) => ReadonlyArray<AzureDevOpsServerProfile>,
): EnvironmentProject | undefined {
  const own = findProjectForChangeRequest(projects, link, profilesForEnvironment);
  if (own !== undefined) return own;
  return projects.find((project) => {
    const identity = project.repositoryIdentity;
    return (
      identity?.provider !== undefined &&
      sourceControlClients.get(identity.provider).canReadChangeRequestOnHost(identity, link)
    );
  });
}

export function shouldOpenPullRequestExternally(
  event: Pick<MouseEvent<HTMLElement>, "metaKey" | "ctrlKey"> &
    Partial<Pick<MouseEvent<HTMLElement>, "button">>,
): boolean {
  return event.metaKey || event.ctrlKey || event.button === 1;
}

export function useOpenChangeRequestLink(
  threadRef?: ScopedThreadRef,
  panelRef?: ScopedThreadRef,
): (
  event: Pick<
    MouseEvent<HTMLElement>,
    "preventDefault" | "stopPropagation" | "metaKey" | "ctrlKey"
  >,
  targetUrl: string,
  targetThreadRef?: ScopedThreadRef,
  targetEnvironmentId?: EnvironmentId,
) => boolean {
  const navigate = useNavigate();
  const allProjects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const openInApp = useClientSettings((settings) => settings.pullRequestLinksOpenInApp);
  return (event, targetUrl, targetThreadRef, targetEnvironmentId) => {
    if (!openInApp || shouldOpenPullRequestExternally(event)) return false;
    // Read at click time: every provider status push replaces the config map, and
    // subscribing would hand every rendered link a new handler.
    const serverConfigs = appAtomRegistry.get(environmentServerConfigsAtom);
    const resolvedThreadRef = targetThreadRef ?? threadRef;
    const resolvedPanelRef = panelRef ?? resolvedThreadRef;
    const parsed = parseChangeRequestUrl(targetUrl);
    if (parsed === null) return false;
    const reads = (environmentId: string) =>
      serverConfigs.get(environmentId as EnvironmentId)?.environment.capabilities.pullRequests ===
      true;
    // Beside a thread the panel reads on that thread's environment, so a project from another
    // one could not be read there whatever its remote says: two environments can hold the same
    // repository, and handing the panel the wrong one's id opens a surface that never loads.
    const candidateProjects = resolvedThreadRef
      ? allProjects.filter((project) => project.environmentId === resolvedThreadRef.environmentId)
      : targetEnvironmentId
        ? allProjects.filter((project) => project.environmentId === targetEnvironmentId)
        : allProjects
            .filter((project) => reads(project.environmentId))
            .toSorted(
              (left, right) =>
                Number(right.environmentId === primaryEnvironmentId) -
                Number(left.environmentId === primaryEnvironmentId),
            );
    const selectedSurface = selectSelectedRightPanelSurface(
      useRightPanelStore.getState().byThreadKey,
      resolvedPanelRef,
    );
    const threadProjectId = resolvedThreadRef
      ? readThreadShell(resolvedThreadRef)?.projectId
      : undefined;
    const preferredProjectId =
      threadProjectId ??
      (selectedSurface?.kind === "pull-request" ? selectedSurface.projectId : undefined);
    const preferredEnvironmentId =
      threadProjectId !== undefined
        ? resolvedThreadRef?.environmentId
        : selectedSurface?.kind === "pull-request"
          ? (selectedSurface.environmentId ?? resolvedPanelRef?.environmentId)
          : undefined;
    const profilesForEnvironment = (id: EnvironmentId) =>
      azureDevOpsServerProfiles(serverConfigs.get(id)?.settings ?? { sourceControlHosts: {} });
    const exactProject = findProjectForChangeRequest(
      candidateProjects,
      parsed,
      profilesForEnvironment,
      preferredProjectId !== undefined && preferredEnvironmentId !== undefined
        ? {
            projectId: ProjectId.make(preferredProjectId),
            environmentId: EnvironmentId.make(preferredEnvironmentId),
          }
        : undefined,
    );
    const project =
      exactProject ??
      (resolvedPanelRef
        ? findProjectOnChangeRequestHost(
            candidateProjects.filter(
              (candidate) =>
                serverConfigs.get(candidate.environmentId)?.environment.capabilities
                  .threadPullRequests === true,
            ),
            parsed,
            profilesForEnvironment,
          )
        : undefined);
    if (project === undefined || !reads(project.environmentId)) return false;
    const serverReference = serverPullRequestReference(
      project,
      parsed,
      profilesForEnvironment(project.environmentId),
    );
    const host = serverReference?.host ?? parsed.authority ?? parsed.host;
    const repository =
      serverReference?.repository ??
      (serverConfigs.get(project.environmentId)?.environment.capabilities.threadPullRequests ===
      true
        ? parsed.repository
        : (sourceControlRepositorySelector(project.repositoryIdentity) ?? parsed.repository));
    event.preventDefault();
    event.stopPropagation();
    if (resolvedPanelRef) {
      useRightPanelStore.getState().openPullRequest(resolvedPanelRef, {
        // The standalone PR panel has a synthetic ref; each tab keeps its real environment.
        ...(resolvedPanelRef.environmentId === project.environmentId
          ? {}
          : { environmentId: project.environmentId }),
        projectId: project.id,
        ...(serverConfigs.get(project.environmentId)?.environment.capabilities
          .threadPullRequests === true
          ? { host }
          : {}),
        repository,
        url: targetUrl,
        number: parsed.number,
      });
      if (!resolvedThreadRef) {
        void navigate({
          to: "/pull-requests",
          search: (previous) => ({
            ...previous,
            involvement: previous.involvement ?? "all",
            state: previous.state ?? "all",
            repository,
            number: parsed.number,
            selectedHost: host,
            selectedProjectId: project.id,
            selectedEnvironmentId: project.environmentId,
          }),
          replace: true,
        });
      }
      return true;
    }
    void navigate({
      to: "/pull-requests",
      search: {
        involvement: "all",
        state: "all",
        repository,
        number: parsed.number,
        selectedHost: host,
        selectedProjectId: project.id,
        selectedEnvironmentId: project.environmentId,
      },
    });
    return true;
  };
}

export function useOpenPrLink(threadRef?: ScopedThreadRef) {
  const openChangeRequest = useOpenChangeRequestLink(threadRef);
  const openLink = useOpenLink(threadRef);
  return (event: MouseEvent<HTMLElement>, prUrl: string, targetThreadRef?: ScopedThreadRef) => {
    if (event.button > 1) return false;
    event.stopPropagation();
    const openInBrowser = shouldOpenPullRequestExternally(event);
    const isAnchor =
      event.currentTarget instanceof HTMLAnchorElement && event.currentTarget.href.length > 0;
    // A real link already knows how to cmd/ctrl/middle-click. Leave its default
    // action alone so the browser (or Electron's window-open handler) opens
    // the host. Buttons have no href, so they still go through openExternal.
    if (openInBrowser && isAnchor) return false;

    event.preventDefault();
    if (!openInBrowser && openChangeRequest(event, prUrl, targetThreadRef)) return true;

    void openLink(prUrl, { event, threadRef: targetThreadRef }).catch((error: unknown) => {
      console.error(error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open pull request link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    });
    return false;
  };
}
