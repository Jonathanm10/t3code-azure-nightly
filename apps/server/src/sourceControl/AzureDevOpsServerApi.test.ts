import { DEFAULT_SERVER_SETTINGS, SourceControlProviderKind } from "@t3tools/contracts";
// @effect-diagnostics nodeBuiltinImport:off - This integration fixture exercises the real Git helper subprocess and its stdin protocol.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as Redacted from "effect/Redacted";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AzureDevOpsServerApi from "@t3tools/source-control-azure-devops/server/AzureDevOpsServerApi";
import * as AzureProvider from "@t3tools/source-control-azure-devops/server/AzureDevOpsPullRequestProvider";
import * as AzureSourceProvider from "@t3tools/source-control-azure-devops/server/AzureDevOpsSourceControlProvider";

const viewer = "11111111-1111-1111-1111-111111111111";
const otherViewer = "22222222-2222-2222-2222-222222222222";
const cloneUrl = "https://git.example.test/tfs/Collection/Project/_git/Repo";
const profiles = [
  {
    apiCollectionUrl: "https://git.example.test/tfs/Collection",
    browserCollectionUrl: "https://web.example.test/tfs/Collection",
  },
];
const pullRequest = {
  pullRequestId: 42,
  title: "Read Server pull requests",
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  creationDate: "2026-10-17T00:00:00Z",
  status: "active",
  createdBy: { id: viewer, uniqueName: "different-upn@example.test", displayName: "Viewer label" },
  reviewers: [
    { id: otherViewer, uniqueName: "another-upn@example.test", displayName: "Reviewer label" },
  ],
  repository: {
    name: "Repo",
    project: { name: "Project" },
    webUrl: "https://web.example.test/tfs/Collection/Project/_git/Repo",
  },
};

function requestUrl(request: HttpClientRequest.HttpClientRequest) {
  const url = new URL(request.url);
  for (const [key, value] of request.urlParams)
    url.searchParams.append(key, Redacted.isRedacted(value) ? Redacted.value(value) : value);
  return url;
}

function requestJson(request: HttpClientRequest.HttpClientRequest) {
  return request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body))
    : undefined;
}

const serverContext = {
  provider: {
    kind: SourceControlProviderKind.make("azure-devops-server"),
    name: "Azure DevOps Server",
    baseUrl: profiles[0]!.apiCollectionUrl,
  },
  remoteName: "origin",
  remoteUrl: cloneUrl,
};

const serverSourceControl = (api: AzureDevOpsServerApi.AzureDevOpsServerApi["Service"]) =>
  AzureSourceProvider.makeServer.pipe(
    Effect.provideService(AzureDevOpsServerApi.AzureDevOpsServerApi, api),
    Effect.provide(NodeServices.layer),
  );

async function fixture() {
  const cwd = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-azure-git-"));
  const config = NodePath.join(cwd, "global.gitconfig");
  const log = NodePath.join(cwd, "helper-log.jsonl");
  const state = NodePath.join(cwd, "account.json");
  const helper = NodePath.join(cwd, "helper.cjs");
  await NodeFSP.writeFile(
    state,
    JSON.stringify({
      viewer,
      expiresAt: 1,
      password: "synthetic-expired",
      refreshToken: "synthetic-old-refresh",
    }),
  );
  await NodeFSP.writeFile(
    helper,
    `const fs = require("node:fs");
const operation = process.argv[2];
const envelope = fs.readFileSync(0,"utf8");
const state = JSON.parse(fs.readFileSync(${JSON.stringify(state)},"utf8"));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({operation,envelope})+"\\n");
if(operation === "store") {
  if(state.failApproval) { process.stderr.write("synthetic-private-approve-error"); process.exit(1); }
  const fields = new Map(envelope.trim().split("\\n").map(line => { const index = line.indexOf("="); return [line.slice(0,index), line.slice(index+1)]; }));
  state.password = fields.get("password");
  state.refreshToken = fields.get("oauth_refresh_token");
  state.expiresAt = Number(fields.get("password_expiry_utc"));
  fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(state));
}
if(operation === "get") {
  const expired = state.expiresAt <= Math.floor(Date.now()/1000);
  const password = expired ? "synthetic-"+state.viewer : state.password;
  const refresh = expired ? "synthetic-rotated-refresh" : state.refreshToken;
  const expires = expired ? Math.floor(Date.now()/1000+3600) : state.expiresAt;
  process.stdout.write("username="+state.viewer+"\\npassword="+password+"\\npassword_expiry_utc="+expires+"\\noauth_refresh_token="+refresh+"\\n\\n");
}
`,
  );
  await NodeFSP.writeFile(
    config,
    `[credential]\nhelper = "!node ${helper}"\nuseHttpPath = true\n[http "https://git.example.test/tfs/Collection"]\nextraHeader = X-Discard: synthetic-before-reset\nextraHeader =\nextraHeader = X-Auth: synthetic-secondary\nextraHeader = X-Multi: one\nextraHeader = X-Multi: two\n[http "https://elsewhere.example.test"]\nextraHeader = X-Foreign: synthetic-foreign\n`,
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_PARAMETERS: "",
    GIT_CONFIG_COUNT: "0",
  };
  NodeChildProcess.execFileSync("git", ["init", "--quiet", cwd], { env });
  NodeChildProcess.execFileSync("git", ["-C", cwd, "remote", "add", "origin", cloneUrl], { env });
  NodeChildProcess.execFileSync(
    "git",
    ["-C", cwd, "config", "--local", "--add", "credential.helper", ""],
    { env },
  );
  NodeChildProcess.execFileSync(
    "git",
    ["-C", cwd, "config", "--local", "--add", "credential.helper", `!node ${helper}`],
    { env },
  );
  const commands: VcsProcess.VcsProcessInput[] = [];
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  let onFill = Effect.void;
  let response: (request: HttpClientRequest.HttpClientRequest) => Response = (request) =>
    requestUrl(request).pathname.endsWith("/_apis/connectionData")
      ? Response.json({ authorizedUser: { id: viewer }, authenticatedUser: { id: otherViewer } })
      : Response.json(pullRequest);
  const run = <A, E>(
    use: (api: AzureDevOpsServerApi.AzureDevOpsServerApi["Service"]) => Effect.Effect<A, E>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const actual = yield* VcsProcess.VcsProcess;
        const runner: VcsProcess.VcsProcess["Service"] = {
          run: (input) => {
            commands.push({
              ...input,
              ...(input.stdin === undefined ? {} : { stdin: "<private>" }),
            });
            const run = actual.run({
              ...input,
              env: {
                ...input.env,
                GIT_CONFIG_GLOBAL: config,
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_CONFIG_PARAMETERS: "",
                GIT_CONFIG_COUNT: "0",
              },
            });
            return input.args[0] === "credential" && input.args[1] === "fill"
              ? onFill.pipe(Effect.andThen(run))
              : run;
          },
        };
        const api = yield* AzureDevOpsServerApi.make.pipe(
          Effect.provide(
            TestSourceControlHost.layer({
              settings: {
                ...DEFAULT_SERVER_SETTINGS,
                sourceControlHosts: { "azure-devops-server": { profiles } },
              },
              process: runner,
            }),
          ),
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests.push(request);
                return HttpClientResponse.fromWeb(request, response(request));
              }),
            ),
          ),
        );
        return yield* use(api);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(VcsProcess.layer, ServerSettingsService.layerTest()).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    );
  return {
    cwd,
    commands,
    requests,
    run,
    setBeforeFill: (effect: Effect.Effect<void>) => {
      onFill = effect;
    },
    setResponse: (next: typeof response) => {
      response = next;
    },
    setViewer: async (id: string) =>
      NodeFSP.writeFile(
        state,
        JSON.stringify({
          viewer: id,
          expiresAt: 1,
          password: "synthetic-expired",
          refreshToken: "synthetic-old-refresh",
        }),
      ),
    failApproval: async () =>
      NodeFSP.writeFile(state, JSON.stringify({ viewer, expiresAt: 1, failApproval: true })),
    storedRefreshPersisted: async () =>
      (await NodeFSP.readFile(state, "utf8")).includes("synthetic-rotated-refresh"),
    failHelper: async () =>
      NodeFSP.writeFile(
        helper,
        'process.stderr.write("synthetic-private-helper-error"); process.exit(1);',
      ),
    helperEvents: async () =>
      (await NodeFSP.readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line): { operation: string; envelope: string } => JSON.parse(line)),
    close: () => NodeFSP.rm(cwd, { recursive: true, force: true }),
  };
}

describe("Azure DevOps Server Git authentication", () => {
  it.effect("omits the connectionData API version and keeps API 6.0 for pull request reads", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
        Effect.promise(fixture.close),
      );
      f.setResponse((request) => {
        const url = requestUrl(request);
        if (url.pathname.endsWith("/_apis/connectionData")) {
          return url.searchParams.has("api-version")
            ? new Response(null, { status: 400 })
            : Response.json({ authorizedUser: { id: viewer } });
        }
        return url.searchParams.get("api-version") === "6.0"
          ? Response.json(pullRequest)
          : new Response(null, { status: 400 });
      });

      const result = yield* f.run((api) => api.reader.getPullRequest({ cwd: f.cwd, number: 42 }));

      expect(result.number).toBe(42);
      expect(result.author?.login).toBe(viewer);
      expect(f.requests.map((request) => requestUrl(request).href)).toEqual([
        "https://git.example.test/tfs/Collection/_apis/connectionData",
        "https://git.example.test/tfs/Collection/Project/_apis/git/repositories/Repo/pullRequests/42?api-version=6.0",
      ]);
    }),
  );

  it.effect("reports a credential persistence failure without exposing helper stderr", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
        Effect.promise(fixture.close),
      );
      yield* Effect.promise(f.failApproval);
      const result = yield* f.run((api) =>
        api.reader.getViewer({ cwd: f.cwd }).pipe(Effect.result),
      );
      expect(Result.isFailure(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
      expect(yield* Effect.promise(f.storedRefreshPersisted)).toBe(false);
      expect((yield* Effect.promise(f.helperEvents)).map((event) => event.operation)).toEqual([
        "get",
        "store",
      ]);
    }),
  );

  it.effect(
    "uses browser aliases only for navigation and never as a credential source for another origin",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        const result = yield* f.run((api) =>
          api
            .withVerifiedCredential(
              {
                cwd: f.cwd,
                remoteUrl: "https://web.example.test/tfs/Collection/Project/_git/Repo",
              },
              () => Effect.succeed("unexpected"),
            )
            .pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(f.commands).toHaveLength(0);
        expect(f.requests).toHaveLength(0);
      }),
  );
  it.effect(
    "uses actual Git fill and URL-matched multi/reset headers, then approves rotated metadata over stdin",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        const result = yield* f.run((api) =>
          api.withVerifiedCredential({ cwd: f.cwd, remoteUrl: cloneUrl }, () =>
            api.reader.getPullRequest({ cwd: f.cwd, number: 42 }),
          ),
        );
        expect(result.author?.login).toBe(viewer);
        expect(result.author?.name).toBe("Viewer label");
        expect(result.reviewers[0]?.login).toBe(otherViewer);
        expect(result.url).toBe(
          "https://web.example.test/tfs/Collection/Project/_git/Repo/pullrequest/42",
        );
        expect(
          f.requests.every(
            (request) =>
              request.method === "GET" && request.url.startsWith(profiles[0]!.apiCollectionUrl),
          ),
        ).toBe(true);
        for (const request of f.requests) {
          expect(request.headers.authorization).toBe(
            `Basic ${Buffer.from(`${viewer}:synthetic-${viewer}`).toString("base64")}`,
          );
          expect(request.headers["x-auth"]).toBe("synthetic-secondary");
          expect(request.headers["x-multi"]).toBe("one, two");
          expect(request.headers["x-discard"]).toBeUndefined();
          expect(request.headers["x-foreign"]).toBeUndefined();
        }
        const events = yield* Effect.promise(f.helperEvents);
        expect(events.map((event) => event.operation)).toEqual(["get", "store"]);
        expect(events[0]?.envelope).toContain("path=tfs/Collection/Project/_git/Repo");
        expect(events[1]?.envelope).toContain("oauth_refresh_token=synthetic-rotated-refresh");
        expect(events[1]?.envelope).toContain("password_expiry_utc=");
        expect(yield* Effect.promise(f.storedRefreshPersisted)).toBe(true);
        expect(JSON.stringify(f.commands)).not.toContain("synthetic-");
      }),
  );

  it.effect("sanitizes helper failures and suppresses repeated automatic sign-in attempts", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
        Effect.promise(fixture.close),
      );
      yield* Effect.promise(f.failHelper);
      const result = yield* f.run((api) =>
        Effect.gen(function* () {
          const first = yield* api.reader.getViewer({ cwd: f.cwd }).pipe(Effect.result);
          const second = yield* api.reader.getViewer({ cwd: f.cwd }).pipe(Effect.result);
          return { first, second };
        }),
      );
      expect(Result.isFailure(result.first)).toBe(true);
      expect(Result.isFailure(result.second)).toBe(true);
      expect(JSON.stringify(result)).not.toContain("synthetic-private");
      expect(f.requests).toHaveLength(0);
      expect(
        f.commands.filter(
          (command) => command.args[0] === "credential" && command.args[1] === "fill",
        ),
      ).toHaveLength(1);
    }),
  );

  it.effect("starts the authentication cooldown when a slow helper failure completes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1_000);
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
        Effect.promise(fixture.close),
      );
      f.setBeforeFill(TestClock.adjust("30 seconds"));
      yield* Effect.promise(f.failHelper);
      yield* f.run((api) =>
        Effect.gen(function* () {
          const read = () => api.withVerifiedCredential({ cwd: f.cwd }, () => Effect.void);
          yield* Effect.flip(read());
          const paused = yield* Effect.flip(read());
          expect(paused.retryAt).toBe(61_000);
          yield* TestClock.adjust("29 seconds");
          yield* Effect.flip(read());
          expect(f.commands.filter((command) => command.args[1] === "fill")).toHaveLength(1);
          yield* TestClock.adjust("1 second");
          yield* Effect.flip(read());
          expect(f.commands.filter((command) => command.args[1] === "fill")).toHaveLength(2);
        }),
      );
      expect(f.requests).toHaveLength(0);
    }),
  );

  it.effect(
    "coalesces concurrent acquisitions and uses the effective GUID rather than authenticatedUser",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        const result = yield* f.run((api) =>
          Effect.all(
            [1, 2, 3].map(() =>
              api.withVerifiedCredential({ cwd: f.cwd }, (identity) =>
                Effect.succeed(identity.viewer),
              ),
            ),
            { concurrency: "unbounded" },
          ),
        );
        expect(result).toEqual([viewer, viewer, viewer]);
        expect((yield* Effect.promise(f.helperEvents)).map((event) => event.operation)).toEqual([
          "get",
          "store",
        ]);
      }),
  );

  it.effect(
    "never approves or rejects a failed gateway and sanitizes bodies and failure causes",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        f.setResponse(
          () =>
            new Response("synthetic-password synthetic-rotated-refresh", {
              status: 403,
              headers: { "Content-Type": "application/json" },
            }),
        );
        const result = yield* f.run((api) =>
          api.reader.getViewer({ cwd: f.cwd }).pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("synthetic-");
        expect((yield* Effect.promise(f.helperEvents)).map((event) => event.operation)).toEqual([
          "get",
        ]);
      }),
  );

  it.effect(
    "rejects redirects without forwarding credentials or accepting HTML as authenticated JSON",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        f.setResponse(
          () =>
            new Response(null, {
              status: 302,
              headers: { Location: "https://elsewhere.example.test/sign-in" },
            }),
        );
        const result = yield* f.run((api) =>
          api.reader.getViewer({ cwd: f.cwd }).pipe(Effect.result),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(f.requests).toHaveLength(1);
        expect((yield* Effect.promise(f.helperEvents)).map((event) => event.operation)).toEqual([
          "get",
        ]);
      }),
  );

  it.effect(
    "filters Mine/Reviewing by GUID and shares nonempty paged diffs with the native provider",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        f.setResponse((request) => {
          if (requestUrl(request).pathname.endsWith("/_apis/connectionData"))
            return Response.json({ authorizedUser: { id: viewer } });
          if (requestUrl(request).pathname.endsWith("/iterations"))
            return Response.json({
              value: [
                {
                  id: 1,
                  sourceRefCommit: { commitId: "head" },
                  commonRefCommit: { commitId: "base" },
                },
              ],
            });
          if (requestUrl(request).pathname.endsWith("/changes"))
            return requestUrl(request).searchParams.get("$skip") === "0"
              ? Response.json({
                  nextSkip: 1,
                  changeEntries: [
                    { changeType: "edit", item: { path: "/file.ts", objectId: "blob" } },
                  ],
                })
              : Response.json({
                  changeEntries: [
                    { changeType: "add", item: { path: "/second.ts", objectId: "second-blob" } },
                  ],
                });
          if (requestUrl(request).pathname.endsWith("/items"))
            return Response.json({
              content:
                requestUrl(request).searchParams.get("versionDescriptor.version") === "head"
                  ? "new\n"
                  : "old\n",
            });
          if (requestUrl(request).pathname.endsWith("/pullRequests"))
            return Response.json({ value: [pullRequest] });
          return Response.json(pullRequest);
        });
        const result = yield* f.run((api) =>
          Effect.gen(function* () {
            const provider = yield* AzureProvider.makeWithReader(api.reader, api);
            const diff = yield* provider.getDiff({
              cwd: f.cwd,
              host: "git.example.test",
              repository: "Repo",
              number: 42,
            });
            const mine = yield* provider.listChangeRequests({
              cwd: f.cwd,
              host: "git.example.test",
              repository: "Repo",
              state: "open",
              involvement: "authored",
              viewer: "wrong-upn",
              limit: 10,
            });
            yield* provider.listChangeRequests({
              cwd: f.cwd,
              host: "git.example.test",
              repository: "Repo",
              state: "open",
              involvement: "reviewing",
              viewer: "wrong-upn",
              limit: 10,
            });
            const refused = yield* provider
              .runAction({
                cwd: f.cwd,
                host: "git.example.test",
                repository: "Repo",
                number: 42,
                action: "merge",
              })
              .pipe(Effect.result);
            return { diff, mine, refused, capabilities: provider.capabilities };
          }),
        );
        expect(result.diff.patch).toContain("-old\n+new");
        expect(result.diff.patch).toContain("second.ts");
        expect(result.mine.items[0]?.author?.login).toBe(viewer);
        expect(
          f.requests.some(
            (request) =>
              requestUrl(request).searchParams.get("searchCriteria.creatorId") === viewer,
          ),
        ).toBe(true);
        expect(
          f.requests.some(
            (request) =>
              requestUrl(request).searchParams.get("searchCriteria.reviewerId") === viewer,
          ),
        ).toBe(true);
        expect(result.capabilities.actions).toEqual([]);
        expect(result.capabilities.edit?.changeRequest).toBe(false);
        expect(Result.isFailure(result.refused)).toBe(true);
        expect(f.commands.every((command) => command.command === "git")).toBe(true);
      }),
  );

  it.effect(
    "propagates conversation and item authentication failures instead of empty success",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        f.setResponse((request) =>
          requestUrl(request).pathname.endsWith("/_apis/connectionData")
            ? Response.json({ authorizedUser: { id: viewer } })
            : requestUrl(request).pathname.endsWith("/threads")
              ? Response.json({ secret: "synthetic-body" }, { status: 401 })
              : Response.json(pullRequest),
        );
        const result = yield* f.run((api) =>
          Effect.gen(function* () {
            const provider = yield* AzureProvider.makeWithReader(api.reader, api);
            return yield* provider
              .getChangeRequestActivity({
                cwd: f.cwd,
                host: "git.example.test",
                repository: "Repo",
                number: 42,
              })
              .pipe(Effect.result);
          }),
        );
        expect(Result.isFailure(result)).toBe(true);
        expect(JSON.stringify(result)).not.toContain("synthetic-");
      }),
  );

  it.effect(
    "pins one account during a read and reacquires changed Git credentials on the next operation",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        let current = viewer;
        f.setResponse(() => Response.json({ authorizedUser: { id: current } }));
        const result = yield* f.run((api) =>
          Effect.gen(function* () {
            const first = yield* api.withVerifiedCredential({ cwd: f.cwd }, (identity) =>
              Effect.gen(function* () {
                yield* Effect.promise(() => f.setViewer(otherViewer));
                current = otherViewer;
                return { ...identity, stillPinned: yield* api.reader.getViewer({ cwd: f.cwd }) };
              }),
            );
            const second = yield* api.withVerifiedCredential({ cwd: f.cwd }, Effect.succeed);
            return { first, second };
          }),
        );
        expect(result.first.viewer).toBe(viewer);
        expect(result.first.stillPinned).toBe(viewer);
        expect(result.second.viewer).toBe(otherViewer);
        expect(result.first.credentialFingerprint).not.toBe(result.second.credentialFingerprint);
        expect((yield* Effect.promise(f.helperEvents)).map((event) => event.operation)).toEqual([
          "get",
          "store",
          "get",
          "store",
        ]);
      }),
  );

  it.effect(
    "implements Server source-control reads and refuses every unsupported az workflow",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        f.setResponse((request) =>
          requestUrl(request).pathname.endsWith("/_apis/connectionData")
            ? Response.json({ authorizedUser: { id: viewer } })
            : Response.json({ defaultBranch: "refs/heads/main" }),
        );
        const result = yield* f.run((api) =>
          Effect.gen(function* () {
            const source = yield* serverSourceControl(api);
            const branch = yield* source.getDefaultBranch({ cwd: f.cwd });
            const refused = yield* Effect.all(
              [
                source.checkoutChangeRequest({ cwd: f.cwd, reference: "42" }),
                source.getRepositoryCloneUrls({ cwd: f.cwd, repository: "Repo" }),
                source.createRepository({ cwd: f.cwd, repository: "Repo", visibility: "private" }),
              ].map((operation) => operation.pipe(Effect.result)),
            );
            return { branch, refused };
          }),
        );
        expect(result.branch).toBe("main");
        expect(result.refused.every(Result.isFailure)).toBe(true);
        expect(f.commands.every((command) => command.command === "git")).toBe(true);
      }),
  );

  it.effect(
    "creates a Server pull request on the API host with the checkout's Git credential",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        const bodyFile = NodePath.join(f.cwd, "pull-request-body.md");
        yield* Effect.promise(() => NodeFSP.writeFile(bodyFile, "Generated description\n"));
        f.setResponse((request) =>
          requestUrl(request).pathname.endsWith("/_apis/connectionData")
            ? Response.json({ authorizedUser: { id: viewer } })
            : Response.json(pullRequest, { status: 201 }),
        );
        yield* f.run((api) =>
          serverSourceControl(api).pipe(
            Effect.flatMap((source) =>
              source.createChangeRequest({
                cwd: f.cwd,
                context: serverContext,
                baseRefName: "main",
                headSelector: "feature/create",
                title: "Create Server pull requests",
                bodyFile,
              }),
            ),
          ),
        );
        const writes = f.requests.filter((request) => request.method !== "GET");
        expect(writes.map((request) => [request.method, requestUrl(request).href])).toEqual([
          [
            "POST",
            "https://git.example.test/tfs/Collection/Project/_apis/git/repositories/Repo/pullRequests?api-version=6.0",
          ],
        ]);
        expect(requestJson(writes[0]!)).toEqual({
          title: "Create Server pull requests",
          description: "Generated description\n",
          sourceRefName: "refs/heads/feature/create",
          targetRefName: "refs/heads/main",
          isDraft: false,
        });
        expect(writes[0]!.headers.authorization).toBe(
          `Basic ${Buffer.from(`${viewer}:synthetic-${viewer}`).toString("base64")}`,
        );
        expect(writes[0]!.headers["x-auth"]).toBe("synthetic-secondary");
      }),
  );

  it.effect("reports a refused Server pull request creation as a permission failure", () =>
    Effect.gen(function* () {
      const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
        Effect.promise(fixture.close),
      );
      const bodyFile = NodePath.join(f.cwd, "pull-request-body.md");
      yield* Effect.promise(() => NodeFSP.writeFile(bodyFile, "Generated description\n"));
      f.setResponse((request) =>
        requestUrl(request).pathname.endsWith("/_apis/connectionData")
          ? Response.json({ authorizedUser: { id: viewer } })
          : Response.json({ message: "synthetic-denied-body" }, { status: 403 }),
      );
      const failure = yield* f.run((api) =>
        serverSourceControl(api).pipe(
          Effect.flatMap((source) =>
            source.createChangeRequest({
              cwd: f.cwd,
              context: serverContext,
              baseRefName: "refs/heads/main",
              headSelector: "feature/create",
              title: "Create Server pull requests",
              bodyFile,
            }),
          ),
          Effect.flip,
        ),
      );
      expect(failure.detail).toBe("The operation is not permitted.");
      expect(failure.message).not.toContain("read-only");
      expect(JSON.stringify(failure)).not.toContain("synthetic-");
      const writes = f.requests.filter((request) => request.method !== "GET");
      expect(writes).toHaveLength(1);
      expect(requestJson(writes[0]!)).toMatchObject({ targetRefName: "refs/heads/main" });
    }),
  );

  it.effect(
    "fails the diff on an item gateway error and keeps a missing file visibly unreadable",
    () =>
      Effect.gen(function* () {
        const f = yield* Effect.acquireRelease(Effect.promise(fixture), (fixture) =>
          Effect.promise(fixture.close),
        );
        let itemStatus = 403;
        f.setResponse((request) => {
          const path = requestUrl(request).pathname;
          if (path.endsWith("/_apis/connectionData"))
            return Response.json({ authorizedUser: { id: viewer } });
          if (path.endsWith("/iterations"))
            return Response.json({
              value: [
                {
                  id: 1,
                  sourceRefCommit: { commitId: "head" },
                  commonRefCommit: { commitId: "base" },
                },
              ],
            });
          if (path.endsWith("/changes"))
            return Response.json({
              changeEntries: [{ changeType: "edit", item: { path: "/file.ts", objectId: "blob" } }],
            });
          if (path.endsWith("/items"))
            return Response.json({ secret: "synthetic-body" }, { status: itemStatus });
          return Response.json(pullRequest);
        });
        const result = yield* f.run((api) =>
          Effect.gen(function* () {
            const provider = yield* AzureProvider.makeWithReader(api.reader, api);
            const input = { cwd: f.cwd, host: "git.example.test", repository: "Repo", number: 42 };
            const refused = yield* provider.getDiff(input).pipe(Effect.result);
            itemStatus = 404;
            const missing = yield* provider.getDiff(input);
            return { refused, missing };
          }),
        );
        expect(Result.isFailure(result.refused)).toBe(true);
        expect(JSON.stringify(result.refused)).not.toContain("synthetic-");
        expect(result.missing.patch).toContain("file.ts");
        expect(result.missing.truncated).toBe(true);
      }),
  );
});
