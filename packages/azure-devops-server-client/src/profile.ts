import * as Schema from "effect/Schema";

export const CollectionUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/[^\s]+$/u),
);
export const AzureDevOpsServerProfile = Schema.Struct({
  apiCollectionUrl: CollectionUrl,
  browserCollectionUrl: Schema.optionalKey(CollectionUrl),
});
export type AzureDevOpsServerProfile = typeof AzureDevOpsServerProfile.Type;
export const AzureServerProfile = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  apiCollectionUrl: CollectionUrl,
  browserCollectionUrl: Schema.optionalKey(CollectionUrl),
  credentialContext: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  remoteUrl: Schema.optionalKey(CollectionUrl),
  defaultProject: Schema.optionalKey(Schema.String),
  defaultTeam: Schema.optionalKey(Schema.String),
});
export type AzureServerProfile = typeof AzureServerProfile.Type;
