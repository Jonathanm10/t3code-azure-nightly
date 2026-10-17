import {
  AzureDevOpsServerProfiles,
  type AzureDevOpsServerProfile,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const AzureDevOpsServerSettings = Schema.Struct({
  profiles: AzureDevOpsServerProfiles.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
const decodeSettings = Schema.decodeUnknownOption(AzureDevOpsServerSettings);
export function azureDevOpsServerProfiles(
  settings: Pick<ServerSettings, "sourceControlHosts">,
): ReadonlyArray<AzureDevOpsServerProfile> {
  const decoded = decodeSettings(settings.sourceControlHosts["azure-devops-server"] ?? {});
  return decoded._tag === "Some" ? decoded.value.profiles : [];
}

function collectionUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return null;
    url.pathname = url.pathname.replace(/\/+$/u, "");
    return url;
  } catch {
    return null;
  }
}

function segment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded && !/[/\\\r\n]/u.test(decoded) && decoded !== "." && decoded !== ".."
      ? decoded
      : null;
  } catch {
    return null;
  }
}

/** A configured API collection and its optional browser alias share one repository identity. */
export function resolveAzureDevOpsServerAddress(
  value: string,
  profiles: ReadonlyArray<AzureDevOpsServerProfile>,
) {
  const url = collectionUrl(value.split(/[?#]/u)[0] ?? value);
  if (url === null) return null;
  const matches = profiles.flatMap((profile) => {
    const api = collectionUrl(profile.apiCollectionUrl);
    const browser = collectionUrl(profile.browserCollectionUrl ?? profile.apiCollectionUrl);
    if (api === null || browser === null) return [];
    const root = [api, browser].find(
      (candidate) =>
        candidate.origin === url.origin &&
        url.pathname.toLowerCase().startsWith(`${candidate.pathname.toLowerCase()}/`),
    );
    if (root === undefined) return [];
    const match = /^\/([^/]+)\/_git\/([^/]+)(?:\/pullrequest\/(\d+)\/?|\/?)$/iu.exec(
      url.pathname.slice(root.pathname.length),
    );
    if (match === null) return [];
    const project = segment(match[1] ?? "");
    const repository = segment(match[2] ?? "");
    const number = match[3] === undefined ? null : Number(match[3]);
    if (
      project === null ||
      repository === null ||
      (number !== null && (!Number.isSafeInteger(number) || number < 1))
    )
      return [];
    const repositoryPath = `${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
    return [
      {
        deployment: "server" as const,
        profile,
        apiCollectionUrl: api.href.replace(/\/$/u, ""),
        browserCollectionUrl: browser.href.replace(/\/$/u, ""),
        collectionKey: `${api.host}${api.pathname}`.toLowerCase(),
        host: api.host.toLowerCase(),
        project,
        repository,
        number,
        canonicalKey: `${api.host}${api.pathname}/${repositoryPath}`.toLowerCase(),
        apiRepositoryUrl: `${api.href.replace(/\/$/u, "")}/${repositoryPath}`,
        browserRepositoryUrl: `${browser.href.replace(/\/$/u, "")}/${repositoryPath}`,
        originalUrl: value,
      },
    ];
  });
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

export type AzureDevOpsServerAddress = NonNullable<
  ReturnType<typeof resolveAzureDevOpsServerAddress>
>;

export function azureDevOpsServerPullRequestUrl(address: AzureDevOpsServerAddress, number: number) {
  return `${address.browserRepositoryUrl}/pullrequest/${number}`;
}
