import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  makeAzureServerClient,
  AzureServerError as AzureDevOpsServerReadError,
  type AzureSession,
  type AzureDevOpsServerAddress,
} from "@jonathanm10/azure-devops-server-client";
import {
  azureDevOpsServerPullRequestUrl,
  azureDevOpsServerProfiles,
} from "@t3tools/shared/azureDevOps";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";
import type {
  AzureDevOpsPullRequestCli,
  AzureDevOpsIterationChanges,
} from "./AzureDevOpsPullRequestCli.ts";
import {
  decodePullRequestJson,
  decodePullRequestListJson,
  decodeThreadsJson,
  decodeIterationsJson,
  decodeIterationChangesJson,
  decodeItemContentJson,
  type AzureDevOpsPullRequest,
} from "./azureDevOpsPullRequestJson.ts";
export { AzureServerError as AzureDevOpsServerReadError } from "@jonathanm10/azure-devops-server-client";
const PinnedSessions = Context.Reference<ReadonlyMap<string, AzureSession>>(
  "t3/AzureDevOpsServer/PinnedSessions",
  { defaultValue: () => new Map() },
);
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type ReadInput = { readonly cwd: string; readonly remoteUrl?: string };
type Identity = Pick<AzureSession, "viewer" | "credentialFingerprint"> & {
  readonly accountId: string;
};
type WithCredential = <A, E, R>(
  input: ReadInput,
  use: (identity: Identity) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | AzureDevOpsServerReadError, R>;

export class AzureDevOpsServerApi extends Context.Service<
  AzureDevOpsServerApi,
  {
    readonly reader: AzureDevOpsPullRequestCli["Service"];
    readonly withVerifiedCredential: WithCredential;
    readonly credentialNamespace: Effect.Effect<string | null>;
    readonly resolveAddress: (
      input: ReadInput,
    ) => Effect.Effect<AzureDevOpsServerAddress, AzureDevOpsServerReadError>;
    readonly getDefaultBranch: (
      input: ReadInput,
    ) => Effect.Effect<string | null, AzureDevOpsServerReadError>;
  }
>()("@t3tools/source-control-azure-devops/server/AzureDevOpsServerApi") {}

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost;
  const client = yield* makeAzureServerClient({
    profiles: host.settings.get.pipe(
      Effect.map(azureDevOpsServerProfiles),
      Effect.mapError(
        () =>
          new AzureDevOpsServerReadError({ operation: "configuration", category: "configuration" }),
      ),
    ),
    process: {
      run: (input) =>
        host.process.run(input).pipe(
          Effect.mapError(
            () =>
              new AzureDevOpsServerReadError({
                operation: "gitAuthentication",
                category: "authentication",
              }),
          ),
        ),
    },
  });
  const fail = (
    operation: string,
    category: AzureDevOpsServerReadError["category"],
    status?: number,
  ) =>
    new AzureDevOpsServerReadError({
      operation,
      category,
      ...(status === undefined ? {} : { status }),
    });
  const withVerifiedCredential: WithCredential = (input, use) =>
    client.withSession(input, (session) =>
      Effect.gen(function* () {
        const pinned = yield* PinnedSessions;
        return yield* use({
          viewer: session.viewer,
          accountId: session.viewer,
          credentialFingerprint: session.credentialFingerprint,
        }).pipe(Effect.provideService(PinnedSessions, new Map([...pinned, [input.cwd, session]])));
      }),
    );
  const read = <A>(
    input: ReadInput,
    use: (session: AzureSession) => Effect.Effect<A, AzureDevOpsServerReadError>,
  ) => client.withSession(input, use);
  const location = (
    session: AzureSession,
    input?: { location?: { project: string; repository: string } },
  ) =>
    input?.location ?? { project: session.address.project, repository: session.address.repository };
  const request = (
    session: AzureSession,
    input: { number: number; location?: { project: string; repository: string } },
  ) => ({ ...location(session, input), pullRequestId: input.number });
  const decode = <A>(raw: unknown, decoder: (raw: string) => Result.Result<A, unknown>) => {
    const answer = decoder(jsonString(raw));
    return Result.isSuccess(answer)
      ? Effect.succeed(answer.success)
      : Effect.fail(fail("decode", "response"));
  };
  const unsupported = () => Effect.fail(fail("write", "unsupported"));
  const collectPages = <A>(
    load: (
      cursor: string | undefined,
    ) => Effect.Effect<
      { readonly items: readonly A[]; readonly next: string | null },
      AzureDevOpsServerReadError
    >,
  ) =>
    Effect.gen(function* () {
      const items: A[] = [];
      let cursor: string | undefined;
      for (let pages = 0; pages < 50; pages++) {
        const page = yield* load(cursor);
        items.push(...page.items);
        if (page.next === null) return items;
        if (page.next === cursor || items.length >= 10000)
          return yield* fail("pagination", "response");
        cursor = page.next;
      }
      return yield* fail("pagination", "response");
    });
  const reader: AzureDevOpsPullRequestCli["Service"] = {
    getViewer: (input) => read(input, (session) => Effect.succeed(session.viewer)),
    getPullRequest: (input) =>
      read(input, (session) =>
        Effect.gen(function* () {
          const result = yield* decode(
            yield* session.execute("pullRequests.get", request(session, input)),
            (raw) => decodePullRequestJson(raw, "server"),
          );
          if (result === null || result.location === null || result.number !== input.number)
            return yield* fail("getPullRequest", "response");
          return {
            ...result,
            url: azureDevOpsServerPullRequestUrl(session.address, result.number),
          };
        }),
      ),
    listPullRequests: (input) =>
      read(input, (session) =>
        Effect.gen(function* () {
          const items: AzureDevOpsPullRequest[] = [];
          let consumed = 0;
          let skip = input.cursor?.delivered ?? 0;
          while (items.length < input.limit) {
            const top = Math.min(200, input.limit - items.length + 1);
            const page = yield* session.execute("pullRequests.list", {
              ...location(session),
              status: { open: "active", merged: "completed", closed: "abandoned", all: "all" }[
                input.state
              ] as "active" | "completed" | "abandoned" | "all",
              limit: top,
              offset: skip,
              ...(input.headBranch === undefined
                ? {}
                : { sourceRef: `refs/heads/${input.headBranch.replace(/^refs\/heads\//u, "")}` }),
              ...(input.involvement === "authored" || input.involvement === "reviewing"
                ? { involvement: input.involvement }
                : {}),
            });
            const decoded = yield* decode(page.items, (raw) =>
              decodePullRequestListJson(raw, "server"),
            );
            const remaining = input.limit - items.length;
            const lastIndex = decoded.rawIndexes[remaining - 1];
            const last = lastIndex === undefined ? undefined : page.rawIndexes[lastIndex];
            items.push(
              ...decoded.items.slice(0, remaining).map((item) => ({
                ...item,
                url: azureDevOpsServerPullRequestUrl(session.address, item.number),
              })),
            );
            if (last !== undefined)
              return {
                items,
                truncated: last + 1 < page.rawCount || page.rawCount === top,
                cursorAdvance: consumed + last + 1,
              };
            consumed += page.rawCount;
            if (page.rawCount < top) return { items, truncated: false, cursorAdvance: consumed };
            skip += page.rawCount;
            if (consumed >= 10000) return { items, truncated: true, cursorAdvance: consumed };
          }
          return { items, truncated: false, cursorAdvance: consumed };
        }),
      ),
    listThreads: (input) =>
      read(input, (session) =>
        collectPages((cursor) =>
          session.execute("pullRequests.threads", {
            ...request(session, input),
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ).pipe(
          Effect.flatMap((items) =>
            decode({ value: items }, (raw) => decodeThreadsJson(raw, "server")),
          ),
        ),
      ),
    listIterations: (input) =>
      read(input, (session) =>
        collectPages((cursor) =>
          session.execute("pullRequests.iterations", {
            ...request(session, input),
            limit: 200,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        ).pipe(Effect.flatMap((items) => decode({ value: items }, decodeIterationsJson))),
      ),
    listIterationChanges: (input) =>
      read(input, (session) =>
        Effect.gen(function* () {
          let skip = 0;
          const changes: AzureDevOpsIterationChanges["changes"][number][] = [];
          while (true) {
            const page = yield* decode(
              yield* session.execute("pullRequests.changes", {
                ...request(session, input),
                iterationId: input.iterationId,
                offset: skip,
                limit: 2000,
              }),
              decodeIterationChangesJson,
            );
            changes.push(...page.changes);
            if (page.nextSkip === null) return { changes, truncated: false };
            if (page.nextSkip <= skip || page.nextSkip >= 10000)
              return { changes, truncated: true };
            skip = page.nextSkip;
          }
        }),
      ),
    readItemContent: (input) =>
      read(input, (session) =>
        session
          .execute("repositories.file", {
            ...location(session, input),
            path: input.path,
            commit: input.commit,
          })
          .pipe(
            Effect.flatMap((raw) => decode(raw, decodeItemContentJson)),
            Effect.mapError((error) =>
              (error.category === "response" || error.category === "unsupported") &&
              (error.status === 404 || error.status === 413 || error.operation === "bodySize")
                ? fail("readItemContent", "item-unavailable", error.status)
                : error,
            ),
          ),
      ),
    runPullRequestAction: unsupported,
    updatePullRequest: unsupported,
    setPullRequestReviewers: unsupported,
  };
  return AzureDevOpsServerApi.of({
    reader,
    resolveAddress: client.resolveAddress,
    withVerifiedCredential,
    credentialNamespace: Effect.map(
      PinnedSessions,
      (sessions) =>
        [...sessions.values()]
          .map((session) => session.credentialFingerprint)
          .sort()
          .join("|") || null,
    ),
    getDefaultBranch: (input) =>
      read(input, (session) => session.execute("repositories.defaultBranch", location(session))),
  });
});
export const layer = Layer.effect(AzureDevOpsServerApi, make);
