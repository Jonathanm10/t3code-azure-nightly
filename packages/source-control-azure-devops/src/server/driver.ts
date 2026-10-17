import { providerAuth } from "@t3tools/source-control-core/server/discovery";
import { SourceControlProviderKind } from "@t3tools/contracts";
import { defineSourceControlDriver } from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";

import * as AzureDevOpsPullRequestProvider from "./AzureDevOpsPullRequestProvider.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("azure-devops"),
  make: Effect.all({
    sourceControl: AzureDevOpsSourceControlProvider.make,
    discovery: Effect.succeed(AzureDevOpsSourceControlProvider.discovery),
    pullRequests: AzureDevOpsPullRequestProvider.make,
  }),
});

export const serverDriver = defineSourceControlDriver({
  kind: SourceControlProviderKind.make("azure-devops-server"),
  make: Effect.all({
    sourceControl: AzureDevOpsSourceControlProvider.makeServer,
    discovery: Effect.succeed({
      type: "api" as const,
      kind: SourceControlProviderKind.make("azure-devops-server"),
      label: "Azure DevOps Server",
      installHint: "Configure a collection and use the checkout's Git sign-in.",
      probeAuth: Effect.succeed(
        providerAuth({
          status: "unknown",
          detail: "Authentication is verified through Git when reading a configured collection.",
        }),
      ),
    }),
    pullRequests: AzureDevOpsPullRequestProvider.makeServer,
  }),
});
