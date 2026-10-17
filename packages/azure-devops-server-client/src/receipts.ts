import * as Schema from "effect/Schema";
import * as S from "./schemas.ts";
import { pullRequestRoute, workItemRoute } from "./operation.ts";

const Url = Schema.String.check(Schema.isMaxLength(16384));
const WorkItemRead = Schema.Struct({
  tool: Schema.Literal("azure_workItems_get"),
  arguments: Schema.Struct({ ...S.WorkItemInput, fields: S.FieldSelection }),
});
const WorkItemReceipt = Schema.Struct({
  resource: Schema.Struct({ kind: Schema.Literal("workItem"), id: S.Id, revision: S.Id, url: Url }),
  readBack: WorkItemRead,
});
const WorkItemCommentReceipt = Schema.Struct({
  resource: Schema.Struct({
    kind: Schema.Literal("workItemComment"),
    id: S.Id,
    workItemId: S.Id,
    version: Schema.optionalKey(S.Id),
    url: Url,
  }),
  readBack: Schema.Struct({
    tool: Schema.Literal("azure_workItems_comments"),
    arguments: Schema.Struct(S.WorkItemInput),
  }),
});
const PullRequestRead = Schema.Struct({
  tool: Schema.Literal("azure_pullRequests_get"),
  arguments: Schema.Struct(S.PullRequestInput),
});
const ThreadRead = Schema.Struct({
  tool: Schema.Literal("azure_pullRequests_threads"),
  arguments: Schema.Struct(S.PullRequestInput),
});
const ReviewerRead = Schema.Struct({
  tool: Schema.Literal("azure_pullRequests_reviewers"),
  arguments: Schema.Struct(S.PullRequestInput),
});
const PullRequestReceipt = Schema.Struct({
  resource: Schema.Struct({
    kind: Schema.Literal("pullRequest"),
    id: S.Id,
    sourceCommit: Schema.optionalKey(S.Commit),
    url: Url,
  }),
  readBack: PullRequestRead,
});
const ThreadReceipt = Schema.Struct({
  resource: Schema.Struct({
    kind: Schema.Literal("pullRequestThread"),
    id: S.Id,
    pullRequestId: S.Id,
    url: Url,
  }),
  readBack: ThreadRead,
});
const CommentReceipt = Schema.Struct({
  resource: Schema.Struct({
    kind: Schema.Literal("pullRequestComment"),
    id: Schema.NullOr(S.Id),
    threadId: S.Id,
    pullRequestId: S.Id,
    url: Url,
  }),
  readBack: ThreadRead,
});
const ReviewerReceipt = Schema.Struct({
  resource: Schema.Struct({
    kind: Schema.Literal("pullRequestReviewer"),
    id: S.Guid,
    pullRequestId: S.Id,
    url: Url,
  }),
  readBack: ReviewerRead,
});
export const WriteReceipt = Schema.Union([
  WorkItemReceipt,
  WorkItemCommentReceipt,
  PullRequestReceipt,
  ThreadReceipt,
  CommentReceipt,
  ReviewerReceipt,
]);
export type WriteReceipt = typeof WriteReceipt.Type;
const url = (collection: string, route: string) => `${collection.replace(/\/+$/u, "")}/${route}`;
const prInput = (input: (typeof PullRequestRead.Type)["arguments"]) => ({
  project: input.project,
  repository: input.repository,
  pullRequestId: input.pullRequestId,
});

export const workItemReceipt = (
  input: { project: string },
  item: typeof S.WorkItem.Type,
  collection: string,
): typeof WorkItemReceipt.Type => ({
  resource: {
    kind: "workItem",
    id: item.id,
    revision: item.rev,
    url: url(collection, workItemRoute({ project: input.project, id: item.id })),
  },
  readBack: {
    tool: "azure_workItems_get",
    arguments: { project: input.project, id: item.id, fields: ["System.Id", "System.Rev"] },
  },
});
export const workItemCommentReceipt = (
  input: { project: string },
  comment: typeof S.WorkItemComment.Type,
  collection: string,
): typeof WorkItemCommentReceipt.Type => ({
  resource: {
    kind: "workItemComment",
    id: comment.id,
    workItemId: comment.workItemId,
    ...(comment.version === undefined ? {} : { version: comment.version }),
    url: url(
      collection,
      `${workItemRoute({ project: input.project, id: comment.workItemId })}/comments/${comment.id}`,
    ),
  },
  readBack: {
    tool: "azure_workItems_comments",
    arguments: { project: input.project, id: comment.workItemId },
  },
});
export const pullRequestReceipt = (
  input: { project: string; repository: string },
  pr: typeof S.PullRequest.Type,
  collection: string,
): typeof PullRequestReceipt.Type => {
  const args = {
    project: input.project,
    repository: input.repository,
    pullRequestId: pr.pullRequestId,
  };
  return {
    resource: {
      kind: "pullRequest",
      id: pr.pullRequestId,
      ...(pr.lastMergeSourceCommit === undefined
        ? {}
        : { sourceCommit: pr.lastMergeSourceCommit.commitId }),
      url: url(collection, pullRequestRoute(args)),
    },
    readBack: { tool: "azure_pullRequests_get", arguments: args },
  };
};
export const threadReceipt = (
  input: (typeof PullRequestRead.Type)["arguments"],
  thread: typeof S.Thread.Type,
  collection: string,
): typeof ThreadReceipt.Type => ({
  resource: {
    kind: "pullRequestThread",
    id: thread.id,
    pullRequestId: input.pullRequestId,
    url: url(collection, `${pullRequestRoute(input)}/threads/${thread.id}`),
  },
  readBack: { tool: "azure_pullRequests_threads", arguments: prInput(input) },
});
export const commentReceipt = (
  input: (typeof PullRequestRead.Type)["arguments"] & { threadId: number; commentId?: number },
  comment: typeof S.PullRequestComment.Type,
  collection: string,
): typeof CommentReceipt.Type => {
  const id = comment.id ?? input.commentId ?? null;
  return {
    resource: {
      kind: "pullRequestComment",
      id,
      threadId: input.threadId,
      pullRequestId: input.pullRequestId,
      url: url(
        collection,
        `${pullRequestRoute(input)}/threads/${input.threadId}/comments${id === null ? "" : `/${id}`}`,
      ),
    },
    readBack: { tool: "azure_pullRequests_threads", arguments: prInput(input) },
  };
};
export const reviewerReceipt = (
  input: (typeof PullRequestRead.Type)["arguments"],
  reviewer: Pick<typeof S.Identity.Type, "id">,
  collection: string,
): typeof ReviewerReceipt.Type => ({
  resource: {
    kind: "pullRequestReviewer",
    id: reviewer.id,
    pullRequestId: input.pullRequestId,
    url: url(collection, `${pullRequestRoute(input)}/reviewers/${reviewer.id}`),
  },
  readBack: { tool: "azure_pullRequests_reviewers", arguments: prInput(input) },
});
