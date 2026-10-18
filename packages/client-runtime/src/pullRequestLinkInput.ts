import {
  pullRequestHostOf,
  type AzureDevOpsServerProfile,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import {
  azureDevOpsServerPullRequestUrl,
  resolveAzureDevOpsServerAddress,
} from "@t3tools/shared/azureDevOps";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";

import { sourceControlClients } from "./sourceControlClients.ts";

const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalizedInput =
    sourceControlClients.definitions
      .map((definition) => definition.checkoutCommandArgument(trimmed))
      .find((argument) => argument !== null) ?? trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  if (
    sourceControlClients.definitions.some((definition) =>
      definition.isChangeRequestReference(normalizedInput),
    )
  ) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}

/** The thread project's repository, so a bare number resolves to one of its pull requests. */
export function pullRequestLinkProject(
  identity: RepositoryIdentity | null | undefined,
  profiles: ReadonlyArray<AzureDevOpsServerProfile> = [],
) {
  if (!identity) return null;
  const server = resolveAzureDevOpsServerAddress(identity.locator.remoteUrl, profiles);
  const repository =
    server?.canonicalKey.slice(server.host.length + 1) ??
    identity.displayName ??
    (identity.owner && identity.name ? `${identity.owner}/${identity.name}` : null);
  if (repository === null) return null;
  const definition = sourceControlClients.get(identity.provider ?? "unknown");
  const host = server?.host ?? pullRequestHostOf(identity, definition.kind);
  return {
    host,
    repository,
    webUrl: (number: number) =>
      server !== null
        ? azureDevOpsServerPullRequestUrl(server, number)
        : definition.changeRequestUrl({
            host,
            repository,
            number,
            remoteUrl: identity.locator.remoteUrl,
            webUrl: identity.webUrl,
          }),
  };
}

interface ResolvedLink {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

export function resolveLinkPullRequestInput(input: {
  readonly profiles?: ReadonlyArray<AzureDevOpsServerProfile>;
  readonly reference: string;
  readonly project: {
    readonly host: string;
    readonly repository: string;
    readonly webUrl: (number: number) => string | null;
  } | null;
  readonly hasProject: (reference: ResolvedLink) => boolean;
}): { link: ResolvedLink } | { error: string } | null {
  const parsed =
    parseChangeRequestUrl(input.reference.trim(), input.profiles) !== null
      ? input.reference.trim()
      : parsePullRequestReference(input.reference);
  if (parsed === null) return null;
  const url = parseChangeRequestUrl(parsed, input.profiles);
  if (url !== null) {
    if (!input.hasProject({ ...url, url: parsed })) {
      return { error: `No project in this environment can read ${url.host}/${url.repository}.` };
    }
    return {
      link: { host: url.host, repository: url.repository, number: url.number, url: parsed },
    };
  }
  const number = Number(parsed);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  if (input.project === null) {
    return { error: "Paste a full URL to link a pull request from another repository." };
  }
  const webUrl = input.project.webUrl(number);
  const webReference = webUrl === null ? null : parseChangeRequestUrl(webUrl, input.profiles);
  if (webUrl === null || webReference === null) {
    return { error: "Paste a full URL; this project's host has no known pull request URL." };
  }
  return {
    link: { ...webReference, url: webUrl },
  };
}
