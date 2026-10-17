export {
  makeAzureServerClient,
  type AzureServerClient,
  type AzureSession,
  type AzureRuntime,
  type GitProcessInput,
  type GitProcessOutput,
} from "./client.ts";
export { AzureServerError } from "./errors.ts";
export { AzureServerProfile, AzureDevOpsServerProfile } from "./profile.ts";
export {
  resolveAzureDevOpsServerAddress,
  azureDevOpsServerPullRequestUrl,
  type AzureDevOpsServerAddress,
} from "./addresses.ts";
export {
  operationCatalog,
  operationIsRead,
  isOperationName,
  type OperationName,
  type OperationInput,
  type OperationOutput,
} from "./operations.ts";
export const CLIENT_VERSION = "0.1.0";
export { makeNodeAzureServerClient } from "./node.ts";
