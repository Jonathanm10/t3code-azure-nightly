import * as Schema from "effect/Schema";

export class AzureServerError extends Schema.TaggedError<AzureServerError>()(
  "AzureDevOpsServerReadError",
  {
    operation: Schema.String,
    category: Schema.Literals([
      "configuration",
      "authentication",
      "transport",
      "response",
      "credential-persistence",
      "unsupported",
      "item-unavailable",
      "conflict",
      "denied",
      "indeterminate",
      "closed",
    ]),
    status: Schema.optionalKey(Schema.Int),
    currentRevision: Schema.optionalKey(Schema.Int),
    retryAt: Schema.optionalKey(Schema.Number),
  },
) {
  get detail(): string {
    switch (this.category) {
      case "conflict":
        return "The resource changed. Read it again before retrying.";
      case "denied":
        return "The operation is not permitted.";
      case "indeterminate":
        return "The write may have reached the server. Read the resource before retrying.";
      case "closed":
        return "The operation-scoped session has ended.";
      case "configuration":
        if (this.operation === "cursor")
          return "This page cursor is no longer valid for this MCP process, checkout, identity or query. Start the listing again in the same process.";
        return "Configure a matching HTTPS Azure DevOps Server collection in Source Control settings.";
      case "authentication":
        return "Git authentication could not be verified. Check Git sign-in on the environment machine, then retry.";
      case "credential-persistence":
        return "Git authenticated, but its credential helper could not save the refreshed credential. Check Git sign-in on the environment machine, then retry.";
      case "unsupported":
        return "This Azure DevOps Server operation is unavailable.";
      case "item-unavailable":
        return "The file is absent or exceeds the Azure DevOps Server read limit.";
      case "transport":
        return "The Azure DevOps Server read could not be completed. Retry after checking the environment connection.";
      case "response":
        return `Azure DevOps Server returned an unusable response${this.status === undefined ? "" : ` (HTTP ${this.status})`}.`;
    }
  }
  override get message() {
    return this.detail;
  }
}
