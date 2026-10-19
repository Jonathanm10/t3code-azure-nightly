import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { AzureDevOpsServerApi } from "./AzureDevOpsServerApi.ts";
import type { AzureDevOpsPullRequest } from "./azureDevOpsPullRequestJson.ts";
import { parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { resolveAzureDevOpsServerAddress } from "@t3tools/shared/azureDevOps";
import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { SourceControlProviderError, type ChangeRequest } from "@t3tools/contracts";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  combinedAuthOutput,
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";

function parseAzureAuth(input: SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account !== undefined && account.length > 0) {
    return providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("azure-devops"),
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  // `az` boots a fresh Python interpreter on every invocation, so even `az --version` takes ~6s
  // on Windows and overruns the default budget, leaving the provider reported as missing on
  // machines where it is installed.
  probeTimeoutMs: 20_000,
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlCliDiscoverySpec;

function toChangeRequest(summary: {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly isDraft?: boolean;
  readonly isCrossRepository: boolean;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt: ChangeRequest["updatedAt"];
}): ChangeRequest {
  return {
    provider: SourceControlProviderKind.make("azure-devops"),
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    state: summary.state,
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    isCrossRepository: summary.isCrossRepository,
  };
}

export const make = Effect.gen(function* () {
  const azure = yield* AzureDevOpsCli.AzureDevOpsCli;

  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops"),
    listChangeRequests: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .listPullRequests({
          cwd: input.cwd,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          state: input.state,
          ...(input.limit !== undefined ? { limit: input.limit } : {}),
        })
        .pipe(
          Effect.map((items) => items.map(toChangeRequest)),
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "listChangeRequests",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getChangeRequest: (input) =>
      azure.getPullRequest(input).pipe(
        Effect.map(toChangeRequest),
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getChangeRequest",
              command: error.command,
              cwd: input.cwd,
              reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.reference,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createChangeRequest: (input) => {
      const source = SourceControlProvider.sourceControlRefFromInput(input);
      return azure
        .createPullRequest({
          cwd: input.cwd,
          baseBranch: input.baseRefName,
          headSelector: input.headSelector,
          ...(source !== undefined ? { source } : {}),
          ...(input.target !== undefined ? { target: input.target } : {}),
          title: input.title,
          bodyFile: input.bodyFile,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "createChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.headSelector,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        );
    },
    getRepositoryCloneUrls: (input) =>
      azure.getRepositoryCloneUrls(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getRepositoryCloneUrls",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    createRepository: (input) =>
      azure.createRepository(input).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "createRepository",
              command: error.command,
              cwd: input.cwd,
              repository: SourceControlProvider.transportSafeSourceControlErrorValue(
                input.repository,
              ),
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    getDefaultBranch: (input) =>
      azure.getDefaultBranch({ cwd: input.cwd }).pipe(
        Effect.mapError(
          (error) =>
            new SourceControlProviderError({
              provider: SourceControlProviderKind.make("azure-devops"),
              operation: "getDefaultBranch",
              command: error.command,
              cwd: input.cwd,
              detail: error.detail,
              cause: error,
            }),
        ),
      ),
    checkoutChangeRequest: (input) =>
      azure
        .checkoutPullRequest({
          cwd: input.cwd,
          reference: input.reference,
          ...(input.context !== undefined ? { remoteName: input.context.remoteName } : {}),
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops"),
                operation: "checkoutChangeRequest",
                command: error.command,
                cwd: input.cwd,
                reference: SourceControlProvider.transportSafeSourceControlErrorValue(
                  input.reference,
                ),
                detail: error.detail,
                cause: error,
              }),
          ),
        ),
  });
});

const isSourceControlError = Schema.is(SourceControlProviderError);
const branchRef = (branch: string) => `refs/heads/${branch.replace(/^refs\/heads\//u, "")}`;

export const makeServer = Effect.gen(function* () {
  const api = yield* AzureDevOpsServerApi;
  const fileSystem = yield* FileSystem.FileSystem;
  const asError = (cwd: string, operation: string) => (error: { readonly detail: string }) =>
    new SourceControlProviderError({
      provider: SourceControlProviderKind.make("azure-devops-server"),
      operation,
      cwd,
      detail: error.detail,
    });
  const unsupported = (input: { cwd: string }, operation: string) =>
    Effect.fail(
      new SourceControlProviderError({
        provider: SourceControlProviderKind.make("azure-devops-server"),
        operation,
        cwd: input.cwd,
        detail: "T3 does not support this Azure DevOps Server operation.",
      }),
    );
  const context = (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
  }) => ({
    cwd: input.cwd,
    ...(input.context === undefined ? {} : { remoteUrl: input.context.remoteUrl }),
  });
  const summary = (item: AzureDevOpsPullRequest): ChangeRequest => ({
    provider: SourceControlProviderKind.make("azure-devops-server"),
    number: item.number,
    title: item.title,
    url: item.url,
    baseRefName: item.baseBranch,
    headRefName: item.headBranch,
    state: item.state,
    isDraft: item.isDraft,
    updatedAt: DateTime.make(item.updatedAt),
    closedAt: item.state === "closed" ? item.closedAt : null,
    mergedAt: item.state === "merged" ? item.closedAt : null,
    isCrossRepository: false,
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("azure-devops-server"),
    listChangeRequests: (input) =>
      api
        .withVerifiedCredential(context(input), (identity) =>
          api.reader
            .listPullRequests({
              cwd: input.cwd,
              repository: "",
              state: input.state,
              involvement: "all",
              viewer: identity.viewer,
              limit: input.limit ?? 100,
              headBranch: SourceControlProvider.sourceBranch(input),
            })
            .pipe(Effect.map((page) => page.items.map(summary))),
        )
        .pipe(Effect.mapError(asError(input.cwd, "listChangeRequests"))),
    getChangeRequest: (input) =>
      api
        .withVerifiedCredential(context(input), () =>
          Effect.gen(function* () {
            const address = yield* api.resolveAddress(context(input));
            const link = parseChangeRequestUrl(input.reference, [address.profile]);
            const target = resolveAzureDevOpsServerAddress(input.reference, [address.profile]);
            const number = /^#?\d+$/u.test(input.reference)
              ? Number(input.reference.replace(/^#/u, ""))
              : link?.number;
            if (
              !number ||
              !Number.isSafeInteger(number) ||
              number < 1 ||
              (target !== null && target.canonicalKey !== address.canonicalKey) ||
              (link !== null && target === null)
            )
              return yield* new SourceControlProviderError({
                provider: SourceControlProviderKind.make("azure-devops-server"),
                operation: "getChangeRequest",
                cwd: input.cwd,
                detail:
                  "The pull request does not belong to this configured Azure DevOps Server repository.",
              });
            return summary(yield* api.reader.getPullRequest({ cwd: input.cwd, number }));
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            isSourceControlError(error) ? error : asError(input.cwd, "getChangeRequest")(error),
          ),
        ),
    getDefaultBranch: (input) =>
      api
        .getDefaultBranch(context(input))
        .pipe(Effect.mapError(asError(input.cwd, "getDefaultBranch"))),
    getRepositoryCloneUrls: (input) => unsupported(input, "getRepositoryCloneUrls"),
    checkoutChangeRequest: (input) => unsupported(input, "checkoutChangeRequest"),
    createChangeRequest: (input) =>
      fileSystem.readFileString(input.bodyFile).pipe(
        Effect.mapError(() => ({ detail: "The pull request description could not be read." })),
        Effect.flatMap((description) =>
          api.createPullRequest({
            ...context(input),
            title: input.title,
            description,
            sourceRef: branchRef(SourceControlProvider.sourceBranch(input)),
            targetRef: branchRef(input.target?.refName ?? input.baseRefName),
          }),
        ),
        Effect.mapError(asError(input.cwd, "createChangeRequest")),
      ),
    createRepository: (input) => unsupported(input, "createRepository"),
  });
});
