import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAzureDevOpsServerAddress } from "./addresses.ts";
import {
  executeUnknownOperation,
  validateOperationInput,
  withOperationDefaults,
} from "./operations.ts";
import type { OperationContext, Request } from "./transport.ts";

const fixture = () => {
  const address = resolveAzureDevOpsServerAddress(
    "https://git.example.test/Collection/Project/_git/Repo",
    [{ apiCollectionUrl: "https://git.example.test/Collection" }],
  );
  if (address === null) throw new Error("Invalid synthetic address");
  const calls: { route: string; options: Parameters<Request>[1] }[] = [];
  const item = { id: 17, rev: 1, fields: { "System.WorkItemType": "Task" } };
  const pr = {
    pullRequestId: 7,
    title: "Fix UI/UX",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    creationDate: "2026-01-01T00:00:00Z",
    repository: { name: "Repo", project: { name: "Project" } },
  };
  const context: OperationContext = {
    address,
    viewer: "11111111-1111-1111-1111-111111111111",
    credentialFingerprint: "synthetic",
    access: "read-write",
    request: (route, options) => {
      calls.push({ route, options });
      const body = route.endsWith("/wiql")
        ? { workItems: [] }
        : route === "_apis/identities"
          ? { value: [] }
          : route.endsWith("/states")
            ? { value: [{ name: "Review/QA" }] }
            : route.includes("/boards/")
              ? {
                  id: "board",
                  name: "Tasks",
                  columns: [{ id: "review", name: "Review/QA", stateMappings: { Task: "Active" } }],
                  rows: [{ id: "fast", name: "UI/UX" }],
                  fields: {
                    columnField: { referenceName: "WEF_board.Column" },
                    rowField: { referenceName: "WEF_board.Lane" },
                  },
                }
              : route.includes("/pullRequests")
                ? pr
                : item;
      return Effect.succeed({ body, continuation: null });
    },
  };
  return { context, calls };
};

it.effect("preserves title punctuation and domain-qualified search through semantic requests", () =>
  Effect.gen(function* () {
    const { context, calls } = fixture();
    const title = "Fix UI/UX";
    yield* executeUnknownOperation(
      "workItems.create",
      { project: "Project", type: "Task", title },
      context,
    );
    expect(calls.at(-1)?.options?.body).toEqual([
      { op: "add", path: "/fields/System.Title", value: title },
    ]);
    yield* executeUnknownOperation(
      "workItems.search",
      { project: "Project", text: "UI/UX's" },
      context,
    );
    expect(calls.at(-1)?.options?.body).toEqual({
      query:
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.Title] CONTAINS 'UI/UX''s' ORDER BY [System.ChangedDate] DESC",
    });
    yield* executeUnknownOperation("identities.search", { query: "DOMAIN\\username" }, context);
    expect(calls.at(-1)?.options?.query).toMatchObject({ filterValue: "DOMAIN\\username" });
    const pr = {
      project: "Project",
      repository: "Repo",
      title,
      description: "Body",
      isDraft: false,
    };
    yield* executeUnknownOperation(
      "pullRequests.create",
      { ...pr, sourceRef: "refs/heads/feature", targetRef: "refs/heads/main" },
      context,
    );
    expect(calls.at(-1)?.options?.body).toMatchObject({ title });
    yield* executeUnknownOperation("pullRequests.edit", { ...pr, pullRequestId: 7 }, context);
    expect(calls.at(-1)?.options?.body).toEqual({ title, description: "Body", isDraft: false });
  }),
);

it.effect("uses slash-containing discovered board labels and state names as field values", () =>
  Effect.gen(function* () {
    const { context, calls } = fixture();
    const revision = { project: "Project", id: 17, expectedRevision: 1 };
    const input = withOperationDefaults(
      "boards.moveCard",
      {
        id: 17,
        expectedRevision: 1,
        board: "Tasks",
        column: "Review/QA",
        lane: "UI/UX",
      },
      {
        id: "synthetic",
        apiCollectionUrl: "https://git.example.test/Collection",
        credentialContext: "/synthetic",
        defaultProject: "Project",
        defaultTeam: "Team",
      },
    );
    expect(input).toMatchObject({ project: "Project", team: "Team" });
    yield* executeUnknownOperation("boards.moveCard", input, context);
    expect(calls.find((call) => call.options?.method === "PATCH")?.options?.body).toEqual([
      { op: "test", path: "/rev", value: 1 },
      { op: "add", path: "/fields/System.State", value: "Active" },
      { op: "add", path: "/fields/WEF_board.Column", value: "Review/QA" },
      { op: "add", path: "/fields/WEF_board.Lane", value: "UI/UX" },
    ]);
    yield* executeUnknownOperation(
      "workItems.transition",
      { ...revision, state: "Review/QA" },
      context,
    );
    expect(calls.at(-2)?.options?.body).toEqual([
      { op: "test", path: "/rev", value: 1 },
      { op: "add", path: "/fields/System.State", value: "Review/QA" },
    ]);
  }),
);

it.effect("keeps route segments, JSON pointer field names, and content bounds strict", () =>
  Effect.gen(function* () {
    const { context, calls } = fixture();
    const failures: readonly [string, Schema.JsonObject][] = [
      ["projects.get", { project: "../escape" }],
      ["workItems.create", { project: "Project", type: "Task/Other", title: "Title" }],
      [
        "workItems.edit",
        {
          project: "Project",
          id: 17,
          expectedRevision: 1,
          edits: [{ field: "Custom/Field", value: "x" }],
        },
      ],
      [
        "workItems.edit",
        {
          project: "Project",
          id: 17,
          expectedRevision: 1,
          edits: [{ field: "Custom~Field", value: "x" }],
        },
      ],
      ["workItems.search", { project: "Project", text: "x".repeat(257) }],
      ["identities.search", { query: "DOMAIN\\user\nname" }],
    ];
    for (const [name, input] of failures) {
      const category = yield* executeUnknownOperation(name, input, context).pipe(
        Effect.match({
          onFailure: (error) => error.category,
          onSuccess: () => "unexpected-success",
        }),
      );
      expect(category).toBe("configuration");
    }
    expect(calls).toHaveLength(0);
    yield* validateOperationInput("workItems.create", {
      project: "Project",
      type: "Task",
      title: "Fix UI/UX",
    });
    yield* validateOperationInput("identities.search", { query: "DOMAIN\\username" });
  }),
);
