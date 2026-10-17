import {
  pullRequestHostOf,
  type PullRequestRef,
  type RepositoryIdentity,
  SourceControlProviderKind,
  type ThreadPullRequestKey,
  type AzureDevOpsServerProfile,
} from "@t3tools/contracts";
import { resolveAzureDevOpsServerAddress } from "@t3tools/shared/azureDevOps";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import { normalizeThreadPullRequestKey } from "@t3tools/shared/threadPullRequests";

export function pullRequestSyncKey(
  reference: PullRequestRef,
  identity?: RepositoryIdentity | null,
  profiles: ReadonlyArray<AzureDevOpsServerProfile> = [],
): ThreadPullRequestKey | null {
  const server =
    identity == null ? null : resolveAzureDevOpsServerAddress(identity.locator.remoteUrl, profiles);
  if (server !== null && !reference.repository.includes("/")) {
    const hosts = [server.host, new URL(server.browserCollectionUrl).host.toLowerCase()];
    if (
      reference.repository.toLowerCase() !== server.repository.toLowerCase() ||
      (reference.host !== undefined && !hosts.includes(reference.host.toLowerCase()))
    )
      return null;
    return {
      host: server.host,
      repository: server.canonicalKey.slice(server.host.length + 1),
      number: reference.number,
    };
  }
  if (identity?.provider === "azure-devops" && !reference.repository.includes("/")) {
    if (
      reference.repository.toLowerCase() !==
        sourceControlRepositorySelector(identity)?.toLowerCase() ||
      (reference.host !== undefined &&
        reference.host.toLowerCase() !==
          pullRequestHostOf(identity, SourceControlProviderKind.make("azure-devops")))
    )
      return null;
    const [host, ...repository] = identity.canonicalKey.split("/");
    if (!host || repository.length === 0) return null;
    return normalizeThreadPullRequestKey({
      host,
      repository: repository.join("/"),
      number: reference.number,
    });
  }
  const host =
    reference.host ??
    (identity
      ? pullRequestHostOf(identity, identity.provider as SourceControlProviderKind)
      : undefined);
  return host === undefined
    ? null
    : normalizeThreadPullRequestKey(
        {
          host,
          repository: reference.repository,
          number: reference.number,
        },
        profiles,
      );
}
