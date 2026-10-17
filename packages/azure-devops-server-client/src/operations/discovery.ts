import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as S from "../schemas.ts";
import { define, page, read, projectRoute, segment } from "../operation.ts";

const classification = Schema.Struct({
  id: S.Id,
  name: Schema.String,
  path: Schema.optionalKey(Schema.String),
  hasChildren: Schema.optionalKey(Schema.Boolean),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: S.Id,
        name: Schema.String,
        path: Schema.optionalKey(Schema.String),
        hasChildren: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
});
export const discovery = {
  "viewer.get": define(
    S.Empty,
    Schema.Struct({ id: S.Guid }),
    { description: "Read the verified Git identity.", readOnly: true },
    (_, context) => Effect.succeed({ id: context.viewer }),
  ),
  "projects.list": define(
    Schema.Struct(S.PageInput),
    S.pageOf(S.Project),
    { description: "List accessible collection projects.", readOnly: true },
    (input, context) => page(context, "_apis/projects", S.Project, input, { mode: "token" }),
  ),
  "projects.get": define(
    Schema.Struct(S.ProjectInput),
    S.Project,
    { description: "Read a collection project.", readOnly: true },
    (input, context) => read(context, `_apis/projects/${segment(input.project)}`, S.Project),
  ),
  "teams.list": define(
    Schema.Struct({ ...S.ProjectInput, ...S.PageInput }),
    S.pageOf(S.Team),
    { description: "List teams in a project.", readOnly: true },
    (input, context) =>
      page(context, `_apis/projects/${segment(input.project)}/teams`, S.Team, input, {
        mode: "skip",
      }),
  ),
  "identities.search": define(
    Schema.Struct({ query: S.DisplayText, ...S.PageInput }),
    S.pageOf(S.Identity),
    { description: "Resolve collection people and groups to identity GUIDs.", readOnly: true },
    (input, context) =>
      page(context, "_apis/identities", S.Identity, input, {
        query: { searchFilter: "General", filterValue: input.query, queryMembership: "None" },
      }),
  ),
  "workItemTypes.list": define(
    Schema.Struct({ ...S.ProjectInput, ...S.PageInput }),
    S.pageOf(S.WorkItemType),
    { description: "Discover project work item types.", readOnly: true },
    (input, context) =>
      page(context, `${projectRoute(input.project)}/wit/workitemtypes`, S.WorkItemType, input),
  ),
  "fields.list": define(
    Schema.Struct({ ...S.ProjectInput, ...S.PageInput }),
    S.pageOf(S.Field),
    { description: "Discover work item field names and editability.", readOnly: true },
    (input, context) => page(context, `${projectRoute(input.project)}/wit/fields`, S.Field, input),
  ),
  "states.list": define(
    Schema.Struct({ ...S.ProjectInput, type: S.Name, ...S.PageInput }),
    S.pageOf(S.WorkItemState),
    { description: "Discover valid states for a work item type.", readOnly: true },
    (input, context) =>
      page(
        context,
        `${projectRoute(input.project)}/wit/workitemtypes/${segment(input.type)}/states`,
        S.WorkItemState,
        input,
        { version: "6.0-preview.1" },
      ),
  ),
  "areas.get": define(
    Schema.Struct(S.ProjectInput),
    classification,
    { description: "Read the project area root and immediate children.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${projectRoute(input.project)}/wit/classificationnodes/areas`,
        classification,
        { $depth: "1" },
      ),
  ),
  "iterations.tree": define(
    Schema.Struct(S.ProjectInput),
    classification,
    { description: "Read the project iteration root and immediate children.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${projectRoute(input.project)}/wit/classificationnodes/iterations`,
        classification,
        { $depth: "1" },
      ),
  ),
};
