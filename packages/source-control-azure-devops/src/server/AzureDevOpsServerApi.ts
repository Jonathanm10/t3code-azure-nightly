// @effect-diagnostics-next-line nodeBuiltinImport:off -- Process-keyed HMAC namespaces must never reveal credential material.
import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import * as Duration from "effect/Duration";
import {
  resolveAzureDevOpsServerAddress,
  azureDevOpsServerPullRequestUrl,
  type AzureDevOpsServerAddress,
} from "@t3tools/shared/azureDevOps";
import { SourceControlHost } from "@t3tools/source-control-core/server/SourceControlHost";
import { azureDevOpsServerProfiles } from "@t3tools/shared/azureDevOps";
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
} from "./azureDevOpsPullRequestJson.ts";
import type { AzureDevOpsPullRequest } from "./azureDevOpsPullRequestJson.ts";

export class AzureDevOpsServerReadError extends Schema.TaggedError<AzureDevOpsServerReadError>()(
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
    ]),
    status: Schema.optionalKey(Schema.Int),
    retryAt: Schema.optionalKey(Schema.Number),
  },
) {
  get detail(): string {
    switch (this.category) {
      case "configuration":
        return "Configure a matching HTTPS Azure DevOps Server collection in Source Control settings.";
      case "authentication":
        return "Git authentication could not be verified. Check Git sign-in on the environment machine, then retry.";
      case "credential-persistence":
        return "Git authenticated, but its credential helper could not save the refreshed credential. Check Git sign-in on the environment machine, then retry.";
      case "unsupported":
        return "Azure DevOps Server is read-only in T3. This operation is unavailable.";
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

const Connection = Schema.Struct({
  authorizedUser: Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu)),
  }),
});
const Page = Schema.Struct({ value: Schema.Array(Schema.Unknown) });
const Repository = Schema.Struct({ defaultBranch: Schema.optionalKey(Schema.String) });
const decodeConnection = Schema.decodeUnknownOption(Connection);
const decodePage = Schema.decodeUnknownOption(Page);
const decodeRepository = Schema.decodeUnknownOption(Repository);

type Session = {
  readonly cwd: string;
  readonly address: AzureDevOpsServerAddress;
  readonly cloneUrl: string;
  readonly envelope: Redacted.Redacted<string>;
  readonly authorization: Redacted.Redacted<string>;
  readonly headerConfig: Redacted.Redacted<
    ReadonlyArray<{ readonly section: string; readonly value: string }>
  >;
  readonly viewer: string;
  readonly credentialFingerprint: string;
};
const PinnedSessions = Context.Reference<ReadonlyMap<string, Session>>(
  "t3/AzureDevOpsServer/PinnedSessions",
  { defaultValue: () => new Map() },
);
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const captureKeyCodec = Schema.fromJsonString(
  Schema.Struct({ cwd: Schema.String, remoteUrl: Schema.String }),
);

type ReadInput = { readonly cwd: string; readonly remoteUrl?: string };
type Identity = Pick<Session, "viewer" | "credentialFingerprint"> & { readonly accountId: string };
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

function gitEnvironment() {
  return {
    ...Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => /^(?:GIT_TRACE|GIT_CURL_VERBOSE|GCM_TRACE)/u.test(key))
        .map((key) => [key, "0"]),
    ),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_TRACE: "0",
    GIT_TRACE_CURL: "0",
    GIT_CURL_VERBOSE: "0",
  };
}

function headerConfig(raw: string) {
  return raw.split("\0").flatMap((entry) => {
    if (!entry) return [];
    const newline = entry.indexOf("\n");
    if (newline < 0) return [];
    return [{ section: entry.slice(0, newline).slice(5, -12), value: entry.slice(newline + 1) }];
  });
}

function headerMatchConfig(entries: ReturnType<typeof headerConfig>) {
  return entries
    .map(
      (entry, index) =>
        `[http${entry.section ? ` ${JSON.stringify(entry.section)}` : ""}]\nextraHeader = ${index}\n`,
    )
    .join("");
}

/** The only transport is GET below a configured collection. No returned URL becomes a request target. */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const fingerprintKey = NodeCrypto.randomBytes(32);
  const gitPermits = yield* Semaphore.make(8);
  const pausedUntil = new Map<string, number>();
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
  const git = Effect.fnUntraced(function* (input: {
    cwd: string;
    args: ReadonlyArray<string>;
    stdin?: string;
    allowMissing?: boolean;
  }) {
    const result = yield* gitPermits
      .withPermits(1)(
        host.process.run({
          operation: "azureDevOpsServerAuthentication",
          command: "git",
          args: input.args,
          cwd: input.cwd,
          env: gitEnvironment(),
          timeoutMs: 30_000,
          allowNonZeroExit: true,
          maxOutputBytes: 128 * 1024,
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
        }),
      )
      .pipe(
        Effect.mapError(() => fail("gitAuthentication", "authentication")),
        Effect.withTracerEnabled(false),
      );
    if (
      result.stdoutTruncated ||
      result.stderrTruncated ||
      result.stdoutInvalidUtf8 ||
      (result.exitCode !== 0 && !(input.allowMissing && result.exitCode === 1))
    )
      return yield* fail("gitAuthentication", "authentication");
    if (
      input.args[0] === "credential" &&
      input.args[1] === "approve" &&
      result.stderr.trim().length > 0
    )
      return yield* fail("approve", "credential-persistence");
    return result.exitCode === 1 ? "" : result.stdout;
  });
  const resolveAddress = Effect.fnUntraced(function* (input: ReadInput) {
    const profiles = yield* host.settings.get.pipe(
      Effect.map(azureDevOpsServerProfiles),
      Effect.mapError(() => fail("configuration", "configuration")),
    );
    const remoteUrl =
      input.remoteUrl ??
      (yield* git({ cwd: input.cwd, args: ["remote", "get-url", "origin"] })).trim();
    const address = resolveAzureDevOpsServerAddress(remoteUrl, profiles);
    if (
      address === null ||
      address.number !== null ||
      new URL(remoteUrl).username ||
      new URL(remoteUrl).password ||
      new URL(remoteUrl).search ||
      new URL(remoteUrl).hash
    )
      return yield* fail("configuration", "configuration");
    const clone = new URL(remoteUrl);
    const api = new URL(address.apiCollectionUrl);
    if (
      clone.origin !== api.origin ||
      !clone.pathname.toLowerCase().startsWith(`${api.pathname.toLowerCase()}/`)
    )
      return yield* fail("configuration", "configuration");
    return { ...address, originalUrl: remoteUrl };
  });

  const getJson = Effect.fnUntraced(function* (
    session: Session,
    route: string,
    query: Readonly<Record<string, string>> = {},
    maxBytes = 16 * 1024 * 1024,
  ) {
    const url = new URL(`${session.address.apiCollectionUrl}/${route}`);
    const collection = new URL(session.address.apiCollectionUrl);
    if (
      url.origin !== collection.origin ||
      !url.pathname.toLowerCase().startsWith(`${collection.pathname.toLowerCase()}/`)
    )
      return yield* fail("read", "configuration");
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    if (route !== "_apis/connectionData") url.searchParams.set("api-version", "6.0");
    const entries = Redacted.value(session.headerConfig);
    if (entries.length > 64) return yield* fail("headers", "configuration");
    // Git's URL matcher exposes only the last value. Prefix markers retain its ordering and
    // specificity decisions while preserving every accepted multi-value header and reset.
    const matches = yield* Effect.forEach(
      entries,
      (_, index) =>
        git({
          cwd: session.cwd,
          args: ["config", "--file", "-", "--null", "--get-urlmatch", "http.extraheader", url.href],
          stdin: headerMatchConfig(entries.slice(0, index + 1)),
          allowMissing: true,
        }).pipe(Effect.map((matched) => matched.replace(/\0$/u, "") === String(index))),
      { concurrency: 4 },
    );
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: Redacted.value(session.authorization),
    };
    const supplementalNames = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (!matches[index]) continue;
      const header = entry.value;
      if (header === "") {
        for (const name of supplementalNames) delete headers[name];
        supplementalNames.clear();
        continue;
      }
      const colon = header.indexOf(":");
      if (colon < 1 || /[\r\n]/u.test(header)) return yield* fail("headers", "configuration");
      const name = header.slice(0, colon).trim().toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~\da-z-]+$/u.test(name) ||
        /^(?:host|authorization|cookie|proxy-authorization|connection|content-length)$/u.test(name)
      )
        return yield* fail("headers", "configuration");
      const value = header.slice(colon + 1).trim();
      if (/[^\t\x20-\x7e\x80-\xff]/u.test(value)) return yield* fail("headers", "configuration");
      headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
      supplementalNames.add(name);
    }
    const response = yield* httpClient
      .execute(HttpClientRequest.get(url.href).pipe(HttpClientRequest.setHeaders(headers)))
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.withTracerEnabled(false),
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail("read", "transport")),
      );
    if (response.status < 200 || response.status >= 300)
      return yield* fail(
        "read",
        response.status === 401 || response.status === 403 ? "authentication" : "response",
        response.status,
      );
    if (
      !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(response.headers["content-type"] ?? "")
    )
      return yield* fail("read", "response", response.status);
    const collected = yield* collectUint8StreamText({ stream: response.stream, maxBytes }).pipe(
      Effect.timeout(Duration.seconds(30)),
      Effect.mapError(() => fail("read", "transport")),
    );
    if (collected.truncated) return yield* fail("bodySize", "response", response.status);
    return yield* decodeJson(collected.text).pipe(
      Effect.mapError(() => fail("decode", "response")),
    );
  });

  const captureFresh = Effect.fnUntraced(function* (key: string) {
    const decoded = yield* Schema.decodeUnknownEffect(captureKeyCodec)(key).pipe(
      Effect.mapError(() => fail("configuration", "configuration")),
    );
    const address = yield* resolveAddress(decoded);
    const now = yield* Clock.currentTimeMillis;
    if ((pausedUntil.get(key) ?? 0) > now)
      return yield* new AzureDevOpsServerReadError({
        operation: "authenticate",
        category: "authentication",
        retryAt: pausedUntil.get(key) ?? now,
      });
    const acquire = Effect.gen(function* () {
      const envelope = yield* git({
        cwd: decoded.cwd,
        args: ["credential", "fill"],
        stdin: `url=${address.originalUrl}\n\n`,
      });
      const fields = new Map(
        envelope
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      );
      const username = fields.get("username");
      const password = fields.get("password");
      const authorization =
        fields.get("authtype") && fields.get("credential")
          ? `${fields.get("authtype")} ${fields.get("credential")}`
          : username !== undefined && password !== undefined
            ? `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
            : null;
      if (authorization === null || /[\r\n]/u.test(authorization))
        return yield* fail("authenticate", "authentication");
      const rawHeaders = yield* git({
        cwd: decoded.cwd,
        args: ["config", "--null", "--get-regexp", "^http(\\..*)?\\.extraheader$"],
        allowMissing: true,
      });
      const helperContext = yield* git({
        cwd: decoded.cwd,
        args: [
          "config",
          "--null",
          "--get-regexp",
          "^credential(\\..*)?\\.(helper|usehttppath|username)$",
        ],
        allowMissing: true,
      });
      const session = {
        cwd: decoded.cwd,
        address,
        cloneUrl: address.originalUrl,
        envelope: Redacted.make(envelope.replace(/\n*$/u, "") + "\n\n"),
        authorization: Redacted.make(authorization),
        headerConfig: Redacted.make(headerConfig(rawHeaders)),
        viewer: "",
        credentialFingerprint: NodeCrypto.createHmac("sha256", fingerprintKey)
          .update(
            jsonString([
              address.apiCollectionUrl,
              address.browserCollectionUrl,
              decoded.cwd,
              address.originalUrl,
              envelope,
              rawHeaders,
              helperContext,
            ]),
          )
          .digest("hex"),
      };
      const connection = decodeConnection(yield* getJson(session, "_apis/connectionData"));
      if (connection._tag === "None") return yield* fail("authenticate", "response");
      yield* git({
        cwd: decoded.cwd,
        args: ["credential", "approve"],
        stdin: Redacted.value(session.envelope),
      }).pipe(Effect.mapError(() => fail("approve", "credential-persistence")));
      pausedUntil.delete(key);
      return { ...session, viewer: connection.value.authorizedUser.id.toLowerCase() };
    });
    return yield* acquire.pipe(
      Effect.tapError(() =>
        Effect.map(Clock.currentTimeMillis, (failedAt) => {
          if (pausedUntil.size >= 128) {
            const oldest = pausedUntil.keys().next().value;
            if (oldest !== undefined) pausedUntil.delete(oldest);
          }
          pausedUntil.set(key, failedAt + 30_000);
        }),
      ),
    );
  });
  const acquisitionFlights = new Map<
    string,
    Deferred.Deferred<Session, AzureDevOpsServerReadError>
  >();
  const capture = (key: string) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const held = acquisitionFlights.get(key);
        if (held !== undefined) return yield* restore(Deferred.await(held));
        if (acquisitionFlights.size >= 128) return yield* fail("authenticate", "transport");
        const completion = yield* Deferred.make<Session, AzureDevOpsServerReadError>();
        acquisitionFlights.set(key, completion);
        const result = yield* restore(captureFresh(key)).pipe(Effect.exit);
        acquisitionFlights.delete(key);
        yield* Deferred.done(completion, result);
        return yield* restore(Deferred.await(completion));
      }),
    );

  const withVerifiedCredential: WithCredential = (input, use) =>
    Effect.gen(function* () {
      const pinned = yield* PinnedSessions;
      const held = pinned.get(input.cwd);
      if (
        held !== undefined &&
        (input.remoteUrl === undefined || held.cloneUrl === input.remoteUrl)
      )
        return yield* use({
          accountId: held.viewer,
          viewer: held.viewer,
          credentialFingerprint: held.credentialFingerprint,
        });
      const address = yield* resolveAddress(input);
      const session = yield* capture(
        jsonString({ cwd: input.cwd, remoteUrl: address.originalUrl }),
      );
      return yield* use({
        accountId: session.viewer,
        viewer: session.viewer,
        credentialFingerprint: session.credentialFingerprint,
      }).pipe(Effect.provideService(PinnedSessions, new Map([...pinned, [input.cwd, session]])));
    });
  const read = <A>(
    input: ReadInput,
    use: (session: Session) => Effect.Effect<A, AzureDevOpsServerReadError>,
  ) =>
    withVerifiedCredential(input, () =>
      Effect.flatMap(PinnedSessions, (sessions) => {
        const session = sessions.get(input.cwd);
        return session === undefined ? Effect.fail(fail("read", "authentication")) : use(session);
      }),
    );
  const repositoryRoute = (session: Session, location?: { project: string; repository: string }) =>
    `${encodeURIComponent(location?.project ?? session.address.project)}/_apis/git/repositories/${encodeURIComponent(location?.repository ?? session.address.repository)}`;
  const prRoute = (
    session: Session,
    input: { number: number; location?: { project: string; repository: string } },
  ) => `${repositoryRoute(session, input.location)}/pullRequests/${input.number}`;
  const decode = <A>(raw: unknown, decoder: (raw: string) => Result.Result<A, unknown>) => {
    const answer = decoder(jsonString(raw));
    return Result.isSuccess(answer)
      ? Effect.succeed(answer.success)
      : Effect.fail(fail("decode", "response"));
  };
  const unsupported = () => Effect.fail(fail("write", "unsupported"));
  const reader: AzureDevOpsPullRequestCli["Service"] = {
    getViewer: (input) => read(input, (session) => Effect.succeed(session.viewer)),
    getPullRequest: (input) =>
      read(input, (session) =>
        Effect.gen(function* () {
          const result = yield* decode(yield* getJson(session, prRoute(session, input)), (raw) =>
            decodePullRequestJson(raw, "server"),
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
            const top = input.limit - items.length + 1;
            const raw = yield* getJson(session, `${repositoryRoute(session)}/pullRequests`, {
              "searchCriteria.status": {
                open: "active",
                merged: "completed",
                closed: "abandoned",
                all: "all",
              }[input.state],
              ...(input.headBranch === undefined
                ? {}
                : {
                    "searchCriteria.sourceRefName": `refs/heads/${input.headBranch.replace(/^refs\/heads\//u, "")}`,
                  }),
              ...(input.involvement === "authored"
                ? { "searchCriteria.creatorId": session.viewer }
                : input.involvement === "reviewing"
                  ? { "searchCriteria.reviewerId": session.viewer }
                  : {}),
              $top: String(top),
              $skip: String(skip),
            });
            const page = decodePage(raw);
            if (page._tag === "None") return yield* fail("listPullRequests", "response");
            const batch = yield* decode(page.value.value, (value) =>
              decodePullRequestListJson(value, "server"),
            );
            const remaining = input.limit - items.length;
            const last = batch.rawIndexes[remaining - 1];
            items.push(
              ...batch.items.slice(0, remaining).map((item) => ({
                ...item,
                url: azureDevOpsServerPullRequestUrl(session.address, item.number),
              })),
            );
            if (last !== undefined)
              return {
                items,
                truncated: last + 1 < batch.rawCount || batch.rawCount === top,
                cursorAdvance: consumed + last + 1,
              };
            consumed += batch.rawCount;
            if (batch.rawCount < top) return { items, truncated: false, cursorAdvance: consumed };
            skip += batch.rawCount;
            if (consumed >= 10_000) return { items, truncated: true, cursorAdvance: consumed };
          }
          return { items, truncated: false, cursorAdvance: consumed };
        }),
      ),
    listThreads: (input) =>
      read(input, (session) =>
        getJson(session, `${prRoute(session, input)}/threads`).pipe(
          Effect.flatMap((raw) => decode(raw, (value) => decodeThreadsJson(value, "server"))),
        ),
      ),
    listIterations: (input) =>
      read(input, (session) =>
        getJson(session, `${prRoute(session, input)}/iterations`).pipe(
          Effect.flatMap((raw) => decode(raw, decodeIterationsJson)),
        ),
      ),
    listIterationChanges: (input) =>
      read(input, (session) =>
        Effect.gen(function* () {
          let skip = 0;
          const changes: AzureDevOpsIterationChanges["changes"][number][] = [];
          while (true) {
            const page = yield* decode(
              yield* getJson(
                session,
                `${prRoute(session, input)}/iterations/${input.iterationId}/changes`,
                { $top: "2000", $skip: String(skip), $compareTo: "0" },
              ),
              decodeIterationChangesJson,
            );
            changes.push(...page.changes);
            if (page.nextSkip === null) return { changes, truncated: false };
            if (page.nextSkip <= skip || page.nextSkip >= 10_000)
              return { changes, truncated: true };
            skip = page.nextSkip;
          }
        }),
      ),
    readItemContent: (input) =>
      read(input, (session) =>
        getJson(
          session,
          `${repositoryRoute(session, input.location)}/items`,
          {
            path: input.path.startsWith("/") ? input.path : `/${input.path}`,
            "versionDescriptor.versionType": "commit",
            "versionDescriptor.version": input.commit,
            includeContent: "true",
            includeContentMetadata: "true",
            $format: "json",
          },
          4 * 1024 * 1024,
        ).pipe(
          Effect.flatMap((raw) => decode(raw, decodeItemContentJson)),
          Effect.mapError((error) =>
            error.category === "response" &&
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
    resolveAddress,
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
      read(input, (session) =>
        Effect.gen(function* () {
          const decoded = decodeRepository(yield* getJson(session, repositoryRoute(session)));
          if (decoded._tag === "None") return yield* fail("getDefaultBranch", "response");
          return decoded.value.defaultBranch?.replace(/^refs\/heads\//u, "") ?? null;
        }),
      ),
  });
});

export const layer = Layer.effect(AzureDevOpsServerApi, make);
