import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as S from "../schemas.ts";
import { AzureServerError } from "../errors.ts";
import {
  define,
  page,
  read,
  segment,
  teamRoute,
  boardRoute,
  projectRoute,
  decodeCursor,
  encodeCursor,
} from "../operation.ts";
import { checkRevision, patchWorkItem, type Patch } from "./workItems.ts";

export const boards = {
  "boards.list": define(
    Schema.Struct({ ...S.TeamInput, ...S.PageInput }),
    S.pageOf(S.Board),
    { description: "Read the team's boards.", readOnly: true },
    (input, context) => page(context, `${teamRoute(input)}/boards`, S.Board, input),
  ),
  "boards.get": define(
    Schema.Struct(S.BoardInput),
    S.Board,
    { description: "Read actual board columns, lanes and field mappings.", readOnly: true },
    (input, context) => read(context, boardRoute(input), S.Board),
  ),
  "boards.columns": define(
    Schema.Struct({ ...S.BoardInput, ...S.PageInput }),
    S.pageOf(S.BoardColumn),
    {
      description: "Read actual board columns and their work item state mappings.",
      readOnly: true,
    },
    (input, context) => page(context, `${boardRoute(input)}/columns`, S.BoardColumn, input),
  ),
  "boards.lanes": define(
    Schema.Struct({ ...S.BoardInput, ...S.PageInput }),
    S.pageOf(S.BoardRow),
    { description: "Read board swimlanes.", readOnly: true },
    (input, context) => page(context, `${boardRoute(input)}/rows`, S.BoardRow, input),
  ),
  "backlogs.list": define(
    Schema.Struct({ ...S.TeamInput, ...S.PageInput }),
    S.pageOf(S.Backlog),
    { description: "Discover team backlog levels.", readOnly: true },
    (input, context) =>
      page(context, `${teamRoute(input)}/backlogs`, S.Backlog, input, { version: "6.0-preview.1" }),
  ),
  "backlogs.items": define(
    Schema.Struct({ ...S.TeamInput, backlog: S.Name }),
    S.BacklogWorkItems,
    { description: "Read real work item relations in a team backlog level.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${teamRoute(input)}/backlogs/${segment(input.backlog)}/workItems`,
        S.BacklogWorkItems,
        {},
        "6.0-preview.1",
      ),
  ),
  "boards.cards": define(
    Schema.Struct({ ...S.BoardInput, ...S.PageInput }),
    S.pageOf(S.WorkItem),
    {
      description: "Resolve the board's backlog and read its actual work item cards.",
      readOnly: true,
    },
    (input, context) =>
      Effect.gen(function* () {
        const board = yield* read(context, boardRoute(input), S.Board);
        const backlogs = yield* read(
          context,
          `${teamRoute(input)}/backlogs`,
          Schema.Struct({ value: Schema.Array(S.Backlog) }),
          {},
          "6.0-preview.1",
        );
        const backlog = backlogs.value.find(
          (item) => item.name === board.name || item.id === board.id,
        );
        if (backlog === undefined)
          return yield* new AzureServerError({
            operation: "boardBacklog",
            category: "unsupported",
          });
        const route = `${teamRoute(input)}/backlogs/${segment(backlog.id)}/workItems`;
        const links = yield* read(context, route, S.BacklogWorkItems, {}, "6.0-preview.1");
        const ids = [...new Set(links.workItems.map((item) => item.target.id))];
        const offset = Number((yield* decodeCursor(context, route, {}, input.cursor)) ?? 0);
        const limit = input.limit ?? 100;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
          return yield* new AzureServerError({ operation: "cursor", category: "configuration" });
        const selected = ids.slice(offset, offset + limit);
        const items =
          selected.length === 0
            ? []
            : (yield* read(
                context,
                `${projectRoute(input.project)}/wit/workitems`,
                Schema.Struct({ value: Schema.Array(S.WorkItem) }),
                { ids: selected.join(","), $expand: "All" },
              )).value;
        return {
          items,
          next:
            offset + limit < ids.length
              ? encodeCursor(context, route, {}, String(offset + limit))
              : null,
        };
      }),
  ),
  "iterations.list": define(
    Schema.Struct({ ...S.TeamInput, ...S.PageInput, current: Schema.optionalKey(Schema.Boolean) }),
    S.pageOf(S.Iteration),
    { description: "Read team sprints, optionally the current sprint.", readOnly: true },
    (input, context) =>
      page(context, `${teamRoute(input)}/teamsettings/iterations`, S.Iteration, input, {
        query: input.current ? { $timeframe: "current" } : {},
      }),
  ),
  "iterations.items": define(
    Schema.Struct({ ...S.TeamInput, iteration: S.Guid }),
    S.WorkItemLinks,
    { description: "Read actual work item relations in a team sprint.", readOnly: true },
    (input, context) =>
      read(
        context,
        `${teamRoute(input)}/teamsettings/iterations/${input.iteration}/workitems`,
        S.WorkItemLinks,
      ),
  ),
  "boards.moveCard": define(
    Schema.Struct({
      ...S.BoardInput,
      id: S.Id,
      expectedRevision: S.Id,
      column: S.Name,
      lane: Schema.optionalKey(S.Name),
      done: Schema.optionalKey(Schema.Boolean),
    }),
    S.WorkItem,
    {
      description:
        "Move a card using the board's actual column, state, lane and done field mappings, then reread it.",
      readOnly: false,
      idempotent: true,
      reconcile: "workItems.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        const board = yield* read(context, boardRoute(input), S.Board);
        const item = yield* checkRevision(context, input);
        const column = board.columns?.find(
          (column) => column.id === input.column || column.name === input.column,
        );
        const type = item.fields["System.WorkItemType"];
        const state = typeof type === "string" ? column?.stateMappings?.[type] : undefined;
        const field = board.fields?.columnField?.referenceName;
        if (column === undefined || field === undefined || state === undefined)
          return yield* new AzureServerError({
            operation: "boardMapping",
            category: "unsupported",
          });
        const patches: Patch[] = [
          { op: "add", path: "/fields/System.State", value: state },
          { op: "add", path: `/fields/${field}`, value: column.name },
        ];
        if (input.lane !== undefined) {
          const lane = board.rows?.find(
            (lane) => lane.id === input.lane || lane.name === input.lane,
          );
          const field = board.fields?.rowField?.referenceName;
          if (lane === undefined || field === undefined)
            return yield* new AzureServerError({
              operation: "boardLane",
              category: "configuration",
            });
          patches.push({ op: "add", path: `/fields/${field}`, value: lane.name ?? "" });
        }
        if (input.done !== undefined) {
          const field = board.fields?.doneField?.referenceName;
          if (field === undefined || column.isSplit !== true)
            return yield* new AzureServerError({
              operation: "boardDone",
              category: "configuration",
            });
          patches.push({ op: "add", path: `/fields/${field}`, value: input.done });
        }
        return yield* patchWorkItem(context, input, patches);
      }),
  ),
  "iterations.assign": define(
    Schema.Struct({ ...S.TeamInput, id: S.Id, expectedRevision: S.Id, iteration: S.Guid }),
    S.WorkItem,
    {
      description:
        "Assign a work item to a discovered team iteration path with an expected revision.",
      readOnly: false,
      idempotent: true,
      reconcile: "workItems.get",
    },
    (input, context) =>
      Effect.gen(function* () {
        const iteration = yield* read(
          context,
          `${teamRoute(input)}/teamsettings/iterations/${input.iteration}`,
          S.Iteration,
        );
        if (iteration.path === undefined)
          return yield* new AzureServerError({ operation: "iterationPath", category: "response" });
        return yield* patchWorkItem(context, input, [
          { op: "add", path: "/fields/System.IterationPath", value: iteration.path },
        ]);
      }),
  ),
};
