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

export {
  resolveAzureDevOpsServerAddress,
  azureDevOpsServerPullRequestUrl,
  type AzureDevOpsServerAddress,
} from "@jonathanm10/azure-devops-server-client/addresses";
