import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as S from "../schemas.ts";
import { workItemReceipt, workItemCommentReceipt } from "../receipts.ts";
import { AzureServerError } from "../errors.ts";
import type { OperationContext } from "../transport.ts";
import {
  define,
  page,
  parse,
  read,
  mutation,
  projectRoute,
  workItemRoute,
  segment,
  decodeCursor,
  encodeCursor,
} from "../operation.ts";

export const getWorkItem = (
  context: OperationContext,
  input: { project: string; id: number; fields?: typeof S.FieldSelection.Type },
) =>
  read(
    context,
    workItemRoute(input),
    S.WorkItem,
    input.fields === undefined ? { $expand: "All" } : { fields: input.fields.join(",") },
  );
export const checkRevision = (
  context: OperationContext,
  input: { project: string; id: number; expectedRevision: number },
) =>
  getWorkItem(context, input).pipe(
    Effect.flatMap((item) =>
      item.rev === input.expectedRevision
        ? Effect.succeed(item)
        : Effect.fail(
            new AzureServerError({
              operation: "revision",
              category: "conflict",
              currentRevision: item.rev,
            }),
          ),
    ),
  );
export type Patch = { op: "add" | "remove" | "test"; path: string; value?: Schema.Json };
export const patchWorkItem = (
  context: OperationContext,
  input: { project: string; id: number; expectedRevision: number },
  patches: ReadonlyArray<Patch>,
) =>
  Effect.gen(function* () {
    yield* mutation(
      context,
      workItemRoute(input),
      S.WorkItem,
      "PATCH",
      [{ op: "test", path: "/rev", value: input.expectedRevision }, ...patches],
      "6.0",
      "application/json-patch+json",
    );
    return yield* getWorkItem(context, input).pipe(
      Effect.mapError(
        () => new AzureServerError({ operation: "verifyWrite", category: "indeterminate" }),
      ),
    );
  });
const fieldEdits = Schema.Array(Schema.Struct({ field: S.FieldName, value: S.FieldValue })).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(50),
);
const guardedField =
  /^(?:System\.(?:State|AssignedTo|IterationPath|Id|Rev|TeamProject|WorkItemType|History|BoardColumn|BoardColumnDone|BoardLane)|WEF_.*)$/iu;
const editsToPatch = (context: OperationContext, project: string, edits: typeof fieldEdits.Type) =>
  Effect.gen(function* () {
    const definitions = yield* read(
      context,
      `${projectRoute(project)}/wit/fields`,
      Schema.Struct({ value: Schema.Array(S.Field) }),
    );
    for (const edit of edits) {
      const field = definitions.value.find((field) => field.referenceName === edit.field);
      if (guardedField.test(edit.field) || field === undefined || field.readOnly === true)
        return yield* new AzureServerError({ operation: "field", category: "configuration" });
    }
    return edits.map((edit) => ({
      op: "add" as const,
      path: `/fields/${edit.field}`,
      value: edit.value,
    }));
  });
const wiql = (
  context: OperationContext,
  input: { project: string; query: string; limit?: number },
) =>
  context
    .request(`${projectRoute(input.project)}/wit/wiql`, {
      method: "POST",
      body: { query: input.query },
      query: { $top: String(input.limit ?? 100) },
    })
    .pipe(Effect.flatMap((response) => parse(S.WorkItemLinks, response.body)));
const commentPage = Schema.Struct({
  comments: Schema.Array(S.WorkItemComment),
  continuationToken: Schema.optionalKey(Schema.String),
  totalCount: Schema.optionalKey(Schema.Int),
});
export const workItems = {
  "workItems.get": define(
    Schema.Struct({ ...S.WorkItemInput, fields: Schema.optionalKey(S.FieldSelection) }),
    S.WorkItem,
    {
      description:
        "Read a work item, revision, fields and relations. Select fields to omit other fields and relations from large items.",
      readOnly: true,
    },
    (input, context) => getWorkItem(context, input),
  ),
  "workItems.batch": define(
    Schema.Struct({
      ...S.ProjectInput,
      ids: Schema.Array(S.Id).check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    }),
    Schema.Array(S.WorkItem),
    { description: "Read up to 200 work items.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${projectRoute(input.project)}/wit/workitems`,
        Schema.Struct({ value: Schema.Array(S.WorkItem) }),
        { ids: input.ids.join(","), $expand: "All" },
      ).pipe(Effect.map((result) => result.value)),
  ),
  "workItems.query": define(
    Schema.Struct({ ...S.ProjectInput, query: S.Text, limit: Schema.optionalKey(S.Limit) }),
    S.WorkItemLinks,
    { description: "Run bounded read-only WIQL. POST is a semantic read.", readOnly: true },
    (input, context) => wiql(context, input),
  ),
  "workItems.search": define(
    Schema.Struct({ ...S.ProjectInput, text: S.DisplayText, limit: Schema.optionalKey(S.Limit) }),
    S.WorkItemLinks,
    { description: "Search titles within a project using WIQL.", readOnly: true },
    (input, context) =>
      wiql(context, {
        project: input.project,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS '${input.text.replaceAll("'", "''")}' ORDER BY [System.ChangedDate] DESC`,
      }),
  ),
  "workItems.history": define(
    Schema.Struct({ ...S.WorkItemInput, ...S.PageInput }),
    S.pageOf(S.WorkItemUpdate),
    { description: "Read bounded work item revision updates.", readOnly: true },
    (input, context) =>
      page(context, `${workItemRoute(input)}/updates`, S.WorkItemUpdate, input, { mode: "skip" }),
  ),
  "workItems.relations": define(
    Schema.Struct(S.WorkItemInput),
    Schema.Array(S.Relation),
    { description: "Read work item relations.", readOnly: true },
    (input, context) =>
      getWorkItem(context, input).pipe(Effect.map((item) => item.relations ?? [])),
  ),
  "workItems.comments": define(
    Schema.Struct({ ...S.WorkItemInput, ...S.PageInput }),
    S.pageOf(S.WorkItemComment),
    {
      description: "Read comments with the Server 6.0-preview.3 comments API. No history fallback.",
      readOnly: true,
    },
    (input, context) =>
      Effect.gen(function* () {
        const route = `${workItemRoute(input)}/comments`;
        const query = { $top: String(input.limit ?? 100) };
        const token = yield* decodeCursor(context, route, query, input.cursor);
        const result = yield* read(
          context,
          route,
          commentPage,
          { ...query, ...(token === null ? {} : { continuationToken: token }) },
          "6.0-preview.3",
        );
        if (result.comments.length > (input.limit ?? 100))
          return yield* new AzureServerError({ operation: "pageLimit", category: "response" });
        return {
          items: result.comments,
          next:
            result.continuationToken === undefined
              ? null
              : encodeCursor(context, route, query, result.continuationToken),
        };
      }),
  ),
  "workItems.create": define(
    Schema.Struct({
      ...S.ProjectInput,
      type: S.Name,
      title: S.DisplayText,
      fields: Schema.optionalKey(fieldEdits),
    }),
    S.WorkItem,
    {
      description: "Create a work item. Reconcile uncertain writes by searching before retrying.",
      readOnly: false,
      receipt: workItemReceipt,
      reconcile: "workItems.search",
    },
    (input, context) =>
      Effect.gen(function* () {
        const extra =
          input.fields === undefined
            ? []
            : yield* editsToPatch(context, input.project, input.fields);
        return yield* mutation(
          context,
          `${projectRoute(input.project)}/wit/workitems/$${segment(input.type)}`,
          S.WorkItem,
          "POST",
          [{ op: "add", path: "/fields/System.Title", value: input.title }, ...extra],
          "6.0",
          "application/json-patch+json",
        );
      }),
  ),
  "workItems.edit": define(
    Schema.Struct({ ...S.RevisionInput, edits: fieldEdits }),
    S.WorkItem,
    {
      description:
        "Edit discovered writable fields using an expected revision. State, assignment, iteration and board fields use dedicated tools.",
      readOnly: false,
      receipt: workItemReceipt,
      idempotent: true,
      reconcile: "workItems.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        const edits = yield* editsToPatch(context, input.project, input.edits);
        return yield* patchWorkItem(context, input, edits);
      }),
  ),
  "workItems.assign": define(
    Schema.Struct({ ...S.RevisionInput, identityId: Schema.NullOr(S.Guid) }),
    S.WorkItem,
    {
      description:
        "Assign to a resolved identity GUID, or clear assignment, with a revision check.",
      readOnly: false,
      receipt: workItemReceipt,
      idempotent: true,
      reconcile: "workItems.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        if (input.identityId !== null) {
          const identities = yield* read(
            context,
            "_apis/identities",
            Schema.Struct({ value: Schema.Array(S.Identity) }),
            { identityIds: input.identityId, queryMembership: "None" },
          );
          if (
            !identities.value.some(
              (person) => person.id.toLowerCase() === input.identityId?.toLowerCase(),
            )
          )
            return yield* new AzureServerError({
              operation: "identity",
              category: "configuration",
            });
        }
        return yield* patchWorkItem(context, input, [
          {
            op: "add",
            path: "/fields/System.AssignedTo",
            value: input.identityId === null ? "" : { id: input.identityId },
          },
        ]);
      }),
  ),
  "workItems.transition": define(
    Schema.Struct({ ...S.RevisionInput, state: S.DisplayText }),
    S.WorkItem,
    {
      description: "Move a work item to a valid type state with an expected revision.",
      readOnly: false,
      receipt: workItemReceipt,
      idempotent: true,
      reconcile: "workItems.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        const item = yield* checkRevision(context, input);
        const type = item.fields["System.WorkItemType"];
        if (typeof type !== "string")
          return yield* new AzureServerError({ operation: "type", category: "response" });
        const states = yield* read(
          context,
          `${projectRoute(input.project)}/wit/workitemtypes/${segment(type)}/states`,
          Schema.Struct({ value: Schema.Array(S.WorkItemState) }),
          {},
          "6.0-preview.1",
        );
        if (!states.value.some((state) => state.name === input.state))
          return yield* new AzureServerError({ operation: "state", category: "configuration" });
        return yield* patchWorkItem(context, input, [
          { op: "add", path: "/fields/System.State", value: input.state },
        ]);
      }),
  ),
  "workItems.comment": define(
    Schema.Struct({ ...S.RevisionInput, text: S.Text }),
    S.WorkItemComment,
    {
      description:
        "Add a comment through 6.0-preview.3 after checking the current revision. The comments API has no atomic revision condition.",
      readOnly: false,
      receipt: workItemCommentReceipt,
      reconcile: "workItems.comments",
    },
    (input, context) =>
      Effect.gen(function* () {
        yield* checkRevision(context, input);
        return yield* mutation(
          context,
          `${workItemRoute(input)}/comments`,
          S.WorkItemComment,
          "POST",
          { text: input.text },
          "6.0-preview.3",
        );
      }),
  ),
  "workItems.link": define(
    Schema.Struct({
      ...S.RevisionInput,
      targetId: S.Id,
      relation: Schema.Literals([
        "System.LinkTypes.Related",
        "System.LinkTypes.Hierarchy-Forward",
        "System.LinkTypes.Hierarchy-Reverse",
        "System.LinkTypes.Dependency-Forward",
        "System.LinkTypes.Dependency-Reverse",
      ]),
    }),
    S.WorkItem,
    {
      description: "Link two work items in this collection with an expected revision.",
      readOnly: false,
      receipt: workItemReceipt,
      reconcile: "workItems.relations",
    },
    (input, context) =>
      patchWorkItem(context, input, [
        {
          op: "add",
          path: "/relations/-",
          value: {
            rel: input.relation,
            url: `${context.address.apiCollectionUrl}/_apis/wit/workItems/${input.targetId}`,
          },
        },
      ]),
  ),
  "workItems.unlink": define(
    Schema.Struct({
      ...S.RevisionInput,
      index: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10000 })),
    }),
    S.WorkItem,
    {
      description: "Remove a relation by its index from the expected work item revision.",
      readOnly: false,
      receipt: workItemReceipt,
      destructive: true,
      reconcile: "workItems.relations",
    },
    (input, context) =>
      patchWorkItem(context, input, [{ op: "remove", path: `/relations/${input.index}` }]),
  ),
};
