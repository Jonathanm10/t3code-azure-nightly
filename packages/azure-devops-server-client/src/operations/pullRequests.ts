import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as S from "../schemas.ts";
import { AzureServerError } from "../errors.ts";
import {
  define,
  page,
  parse,
  read,
  mutation,
  repositoryRoute,
  pullRequestRoute,
  projectRoute,
  decodeCursor,
  encodeCursor,
  segment,
} from "../operation.ts";

const prPage = Schema.Struct({
  items: Schema.Array(S.PullRequest),
  rawIndexes: Schema.Array(Schema.Int),
  rawCount: Schema.Int,
  next: Schema.NullOr(Schema.String),
});
const threadInput = { ...S.PullRequestInput, threadId: S.Id };
const commentInput = { ...threadInput, commentId: S.Id };
const ref = Schema.String.check(
  Schema.isMinLength(12),
  Schema.isMaxLength(1024),
  Schema.isPattern(/^refs\/heads\/[^\r\n\0]+$/u),
);
export const pullRequests = {
  "repositories.defaultBranch": define(
    Schema.Struct(S.RepositoryInput),
    Schema.NullOr(Schema.String),
    { description: "Read the repository default branch.", readOnly: true },
    (input, context) =>
      read(
        context,
        repositoryRoute(input),
        Schema.Struct({ defaultBranch: Schema.optionalKey(Schema.String) }),
      ).pipe(
        Effect.map(
          (repository) => repository.defaultBranch?.replace(/^refs\/heads\//u, "") ?? null,
        ),
      ),
  ),
  "repositories.list": define(
    Schema.Struct({ ...S.ProjectInput, ...S.PageInput }),
    S.pageOf(S.Repository),
    { description: "List project Git repositories.", readOnly: true },
    (input, context) =>
      page(context, `${projectRoute(input.project)}/git/repositories`, S.Repository, input),
  ),
  "repositories.get": define(
    Schema.Struct(S.RepositoryInput),
    S.Repository,
    { description: "Read a repository and its default branch.", readOnly: true },
    (input, context) => read(context, repositoryRoute(input), S.Repository),
  ),
  "branches.list": define(
    Schema.Struct({ ...S.RepositoryInput, ...S.PageInput }),
    S.pageOf(S.Branch),
    { description: "List repository branches and exact commit IDs.", readOnly: true },
    (input, context) =>
      page(context, `${repositoryRoute(input)}/refs`, S.Branch, input, {
        query: { filter: "heads/" },
        mode: "token",
      }),
  ),
  "pullRequests.get": define(
    Schema.Struct(S.PullRequestInput),
    S.PullRequest,
    { description: "Read a pull request, source commit, status and reviewers.", readOnly: true },
    (input, context) =>
      read(context, pullRequestRoute(input), S.PullRequest).pipe(
        Effect.map((pr) => ({
          ...pr,
          repository: {
            ...pr.repository,
            webUrl: `${context.address.browserCollectionUrl}/${segment(pr.repository.project.name)}/_git/${segment(pr.repository.name)}`,
          },
        })),
      ),
  ),
  "pullRequests.list": define(
    Schema.Struct({
      ...S.RepositoryInput,
      ...S.PageInput,
      status: Schema.optionalKey(Schema.Literals(["active", "completed", "abandoned", "all"])),
      sourceRef: Schema.optionalKey(ref),
      involvement: Schema.optionalKey(Schema.Literals(["authored", "reviewing"])),
      offset: Schema.optionalKey(S.Offset),
    }),
    prPage,
    {
      description:
        "Read bounded pull requests, optionally authored by or assigned to the verified viewer.",
      readOnly: true,
    },
    (input, context) =>
      Effect.gen(function* () {
        const route = `${repositoryRoute(input)}/pullRequests`;
        const limit = input.limit ?? 100;
        const query = {
          "searchCriteria.status": input.status ?? "active",
          ...(input.sourceRef === undefined
            ? {}
            : { "searchCriteria.sourceRefName": input.sourceRef }),
          ...(input.involvement === "authored"
            ? { "searchCriteria.creatorId": context.viewer }
            : input.involvement === "reviewing"
              ? { "searchCriteria.reviewerId": context.viewer }
              : {}),
          $top: String(limit),
        };
        const offset =
          input.offset ?? Number((yield* decodeCursor(context, route, query, input.cursor)) ?? 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
          return yield* new AzureServerError({ operation: "cursor", category: "configuration" });
        const raw = yield* read(
          context,
          route,
          Schema.Struct({ value: Schema.Array(Schema.Unknown) }),
          { ...query, $skip: String(offset) },
        );
        if (raw.value.length > limit)
          return yield* new AzureServerError({ operation: "pageLimit", category: "response" });
        const decode = Schema.decodeUnknownOption(S.PullRequest);
        const items: (typeof S.PullRequest.Type)[] = [];
        const rawIndexes: number[] = [];
        for (const [index, value] of raw.value.entries()) {
          const pr = decode(value);
          if (pr._tag === "Some") {
            items.push({
              ...pr.value,
              repository: {
                ...pr.value.repository,
                webUrl: `${context.address.browserCollectionUrl}/${segment(pr.value.repository.project.name)}/_git/${segment(pr.value.repository.name)}`,
              },
            });
            rawIndexes.push(index);
          }
        }
        return {
          items,
          rawIndexes,
          rawCount: raw.value.length,
          next:
            raw.value.length === limit && offset + limit < 10000
              ? encodeCursor(context, route, query, String(offset + limit))
              : null,
        };
      }),
  ),
  "pullRequests.iterations": define(
    Schema.Struct({ ...S.PullRequestInput, ...S.PageInput }),
    S.pageOf(S.PullRequestIteration),
    { description: "Read pull request iterations and source/base commits.", readOnly: true },
    (input, context) =>
      page(context, `${pullRequestRoute(input)}/iterations`, S.PullRequestIteration, input),
  ),
  "pullRequests.changes": define(
    Schema.Struct({
      ...S.PullRequestInput,
      iterationId: S.Id,
      offset: Schema.optionalKey(S.Offset),
      limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2000 }))),
    }),
    S.Changes,
    { description: "Read changed files in an iteration. Continue using nextSkip.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${pullRequestRoute(input)}/iterations/${input.iterationId}/changes`,
        S.Changes,
        { $top: String(input.limit ?? 2000), $skip: String(input.offset ?? 0), $compareTo: "0" },
      ),
  ),
  "repositories.file": define(
    Schema.Struct({
      ...S.RepositoryInput,
      path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
      commit: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    }),
    S.FileContent,
    {
      description: "Read at most 4 MiB of a repository file at a specific commit.",
      readOnly: true,
    },
    (input, context) =>
      context
        .request(`${repositoryRoute(input)}/items`, {
          query: {
            path: input.path.startsWith("/") ? input.path : `/${input.path}`,
            "versionDescriptor.versionType": "commit",
            "versionDescriptor.version": input.commit,
            includeContent: "true",
            includeContentMetadata: "true",
            $format: "json",
          },
          maxBytes: 4 * 1024 * 1024,
        })
        .pipe(Effect.flatMap((result) => parse(S.FileContent, result.body))),
  ),
  "pullRequests.threads": define(
    Schema.Struct({ ...S.PullRequestInput, ...S.PageInput }),
    S.pageOf(S.Thread),
    { description: "Read pull request discussion threads and comments.", readOnly: true },
    (input, context) => page(context, `${pullRequestRoute(input)}/threads`, S.Thread, input),
  ),
  "pullRequests.reviewers": define(
    Schema.Struct({ ...S.PullRequestInput, ...S.PageInput }),
    S.pageOf(S.Identity),
    { description: "Read pull request reviewers and their votes.", readOnly: true },
    (input, context) => page(context, `${pullRequestRoute(input)}/reviewers`, S.Identity, input),
  ),
  "pullRequests.create": define(
    Schema.Struct({
      ...S.RepositoryInput,
      title: S.Name,
      description: S.Text,
      sourceRef: ref,
      targetRef: ref,
      isDraft: Schema.Boolean,
    }),
    S.PullRequest,
    {
      description: "Create a pull request with explicit branches and draft state.",
      readOnly: false,
      reconcile: "pullRequests.list",
    },
    (input, context) =>
      mutation(context, `${repositoryRoute(input)}/pullRequests`, S.PullRequest, "POST", {
        title: input.title,
        description: input.description,
        sourceRefName: input.sourceRef,
        targetRefName: input.targetRef,
        isDraft: input.isDraft,
      }),
  ),
  "pullRequests.edit": define(
    Schema.Struct({
      ...S.PullRequestInput,
      title: S.Name,
      description: S.Text,
      isDraft: Schema.Boolean,
    }),
    S.PullRequest,
    {
      description: "Set pull request title, description and draft state.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.get",
    },
    (input, context) =>
      mutation(context, pullRequestRoute(input), S.PullRequest, "PATCH", {
        title: input.title,
        description: input.description,
        isDraft: input.isDraft,
      }),
  ),
  "pullRequests.comment": define(
    Schema.Struct({ ...S.PullRequestInput, text: S.Text }),
    S.Thread,
    {
      description: "Create a discussion thread on a pull request.",
      readOnly: false,
      reconcile: "pullRequests.threads",
    },
    (input, context) =>
      mutation(context, `${pullRequestRoute(input)}/threads`, S.Thread, "POST", {
        comments: [{ parentCommentId: 0, content: input.text, commentType: 1 }],
        status: 1,
      }),
  ),
  "pullRequests.reply": define(
    Schema.Struct({ ...threadInput, text: S.Text, parentCommentId: Schema.optionalKey(S.Id) }),
    S.PullRequestComment,
    {
      description: "Reply to a pull request discussion thread.",
      readOnly: false,
      reconcile: "pullRequests.threads",
    },
    (input, context) =>
      mutation(
        context,
        `${pullRequestRoute(input)}/threads/${input.threadId}/comments`,
        S.PullRequestComment,
        "POST",
        { content: input.text, parentCommentId: input.parentCommentId ?? 0, commentType: 1 },
      ),
  ),
  "pullRequests.editComment": define(
    Schema.Struct({ ...commentInput, text: S.Text }),
    S.PullRequestComment,
    {
      description: "Edit a pull request comment.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.threads",
    },
    (input, context) =>
      mutation(
        context,
        `${pullRequestRoute(input)}/threads/${input.threadId}/comments/${input.commentId}`,
        S.PullRequestComment,
        "PATCH",
        { content: input.text },
      ),
  ),
  "pullRequests.threadState": define(
    Schema.Struct({
      ...threadInput,
      state: Schema.Literals(["active", "fixed", "wontFix", "closed", "byDesign", "pending"]),
    }),
    S.Thread,
    {
      description: "Set a discussion thread state.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.threads",
    },
    (input, context) =>
      mutation(context, `${pullRequestRoute(input)}/threads/${input.threadId}`, S.Thread, "PATCH", {
        status: input.state,
      }),
  ),
  "pullRequests.vote": define(
    Schema.Struct({ ...S.PullRequestInput, vote: Schema.Literals([-10, -5, 0, 5, 10]) }),
    S.Identity,
    {
      description: "Set the verified viewer's review vote. Cannot impersonate another reviewer.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.reviewers",
    },
    (input, context) =>
      mutation(
        context,
        `${pullRequestRoute(input)}/reviewers/${context.viewer}`,
        S.Identity,
        "PUT",
        { vote: input.vote },
      ),
  ),
  "pullRequests.addReviewer": define(
    Schema.Struct({ ...S.PullRequestInput, identityId: S.Guid, required: Schema.Boolean }),
    S.Identity,
    {
      description: "Add a reviewer by resolved identity GUID.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.reviewers",
    },
    (input, context) =>
      mutation(
        context,
        `${pullRequestRoute(input)}/reviewers/${input.identityId}`,
        S.Identity,
        "PUT",
        { vote: 0, isRequired: input.required },
      ),
  ),
  "pullRequests.removeReviewer": define(
    Schema.Struct({ ...S.PullRequestInput, identityId: S.Guid }),
    Schema.Null,
    {
      description: "Remove a reviewer by GUID.",
      readOnly: false,
      idempotent: true,
      destructive: true,
      reconcile: "pullRequests.reviewers",
    },
    (input, context) =>
      mutation(
        context,
        `${pullRequestRoute(input)}/reviewers/${input.identityId}`,
        Schema.Null,
        "DELETE",
      ),
  ),
  "pullRequests.lifecycle": define(
    Schema.Struct({ ...S.PullRequestInput, status: Schema.Literals(["active", "abandoned"]) }),
    S.PullRequest,
    {
      description: "Abandon or reactivate a pull request.",
      readOnly: false,
      idempotent: true,
      reconcile: "pullRequests.get",
    },
    (input, context) =>
      mutation(context, pullRequestRoute(input), S.PullRequest, "PATCH", { status: input.status }),
  ),
  "pullRequests.complete": define(
    Schema.Struct({
      ...S.PullRequestInput,
      expectedSourceCommit: S.Commit,
      strategy: Schema.Literals(["noFastForward", "squash", "rebase", "rebaseMerge"]),
      deleteSourceBranch: Schema.Boolean,
    }),
    S.PullRequest,
    {
      description:
        "Complete against an expected source commit with an explicit strategy and branch-deletion choice. Never bypass policies.",
      readOnly: false,
      destructive: true,
      reconcile: "pullRequests.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        const current = yield* read(context, pullRequestRoute(input), S.PullRequest);
        if (
          current.lastMergeSourceCommit?.commitId.toLowerCase() !==
          input.expectedSourceCommit.toLowerCase()
        )
          return yield* new AzureServerError({ operation: "sourceCommit", category: "conflict" });
        return yield* mutation(context, pullRequestRoute(input), S.PullRequest, "PATCH", {
          status: "completed",
          lastMergeSourceCommit: { commitId: input.expectedSourceCommit },
          completionOptions: {
            mergeStrategy: input.strategy,
            deleteSourceBranch: input.deleteSourceBranch,
            bypassPolicy: false,
          },
        });
      }),
  ),
};
