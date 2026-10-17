// @effect-diagnostics-next-line nodeBuiltinImport:off -- Process-keyed HMAC namespaces must never reveal credential material.
import * as NodeCrypto from "node:crypto";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, FetchHttpClient } from "effect/http";
import { collectText } from "./stream.ts";
import * as Duration from "effect/Duration";
import { resolveAzureDevOpsServerAddress, type AzureDevOpsServerAddress } from "./addresses.ts";
import type { AzureDevOpsServerProfile } from "./profile.ts";
import { AzureServerError } from "./errors.ts";
import {
  executeOperation,
  executeUnknownOperation,
  isOperationName,
  operationIsRead,
  validateOperationInput,
  type OperationName,
  type OperationInput,
  type OperationOutput,
} from "./operations.ts";
import type { Request } from "./transport.ts";
const Connection = Schema.Struct({
  authorizedUser: Schema.Struct({
    id: Schema.String.check(Schema.isPattern(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/iu)),
  }),
});
const decodeConnection = Schema.decodeUnknownOption(Connection);

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
  "azure-devops-server-client/PinnedSessions",
  { defaultValue: () => new Map() },
);
const jsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const captureKeyCodec = Schema.fromJsonString(
  Schema.Struct({ cwd: Schema.String, remoteUrl: Schema.String }),
);

export type ReadInput = { readonly cwd: string; readonly remoteUrl?: string };
export interface AzureSession {
  readonly viewer: string;
  readonly credentialFingerprint: string;
  readonly address: AzureDevOpsServerAddress;
  executeUnknown(operation: string, input: unknown): Effect.Effect<unknown, AzureServerError>;
  execute<K extends OperationName>(
    operation: K,
    input: OperationInput<K>,
  ): Effect.Effect<OperationOutput<K>, AzureServerError>;
}
export interface GitProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly allowNonZeroExit?: boolean;
  readonly maxOutputBytes?: number;
}
export interface GitProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8?: boolean;
}
export interface AzureRuntime {
  readonly profiles: Effect.Effect<ReadonlyArray<AzureDevOpsServerProfile>, AzureServerError>;
  readonly process: {
    readonly run: (input: GitProcessInput) => Effect.Effect<GitProcessOutput, AzureServerError>;
  };
}
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

export const makeAzureServerClient = (
  runtime: AzureRuntime,
  access: "read" | "read-write" = "read",
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const fingerprintKey = NodeCrypto.randomBytes(32);
    const gitPermits = yield* Semaphore.make(8);
    const pausedUntil = new Map<string, number>();
    const fail = (operation: string, category: AzureServerError["category"], status?: number) =>
      new AzureServerError({
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
          runtime.process.run({
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
      const profiles = yield* runtime.profiles.pipe(
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
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE" = "GET",
      payload?: unknown,
      version = "6.0",
      contentType = "application/json",
      mutation = false,
    ) {
      const url = new URL(`${session.address.apiCollectionUrl}/${route}`);
      const collection = new URL(session.address.apiCollectionUrl);
      if (
        url.origin !== collection.origin ||
        !url.pathname.toLowerCase().startsWith(`${collection.pathname.toLowerCase()}/`)
      )
        return yield* fail("read", "configuration");
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      if (route !== "_apis/connectionData") url.searchParams.set("api-version", version);
      const entries = Redacted.value(session.headerConfig);
      if (entries.length > 64) return yield* fail("headers", "configuration");
      // Git's URL matcher exposes only the last value. Prefix markers retain its ordering and
      // specificity decisions while preserving every accepted multi-value header and reset.
      const matches = yield* Effect.forEach(
        entries,
        (_, index) =>
          git({
            cwd: session.cwd,
            args: [
              "config",
              "--file",
              "-",
              "--null",
              "--get-urlmatch",
              "http.extraheader",
              url.href,
            ],
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
          /^(?:host|authorization|cookie|proxy-authorization|connection|content-length)$/u.test(
            name,
          )
        )
          return yield* fail("headers", "configuration");
        const value = header.slice(colon + 1).trim();
        if (/[^\t\x20-\x7e\x80-\xff]/u.test(value)) return yield* fail("headers", "configuration");
        headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
        supplementalNames.add(name);
      }
      let request = HttpClientRequest.make(method)(url.href).pipe(
        HttpClientRequest.setHeaders(headers),
      );
      if (payload !== undefined)
        request = request.pipe(HttpClientRequest.bodyText(jsonString(payload), contentType));
      const response = yield* httpClient.execute(request).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
        Effect.withTracerEnabled(false),
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail("read", mutation ? "indeterminate" : "transport")),
      );
      if (response.status < 200 || response.status >= 300)
        return yield* fail(
          "read",
          response.status === 401
            ? "authentication"
            : response.status === 403
              ? "denied"
              : response.status === 409 || response.status === 412
                ? "conflict"
                : response.status === 404 || response.status === 405 || response.status === 501
                  ? "unsupported"
                  : mutation && response.status >= 500
                    ? "indeterminate"
                    : "response",
          response.status,
        );
      if (response.status === 204) return { body: null, continuation: null };
      if (
        !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/iu.test(
          response.headers["content-type"] ?? "",
        )
      )
        return yield* fail("read", mutation ? "indeterminate" : "response", response.status);
      const collected = yield* collectText({ stream: response.stream, maxBytes }).pipe(
        Effect.timeout(Duration.seconds(30)),
        Effect.mapError(() => fail("read", mutation ? "indeterminate" : "transport")),
      );
      if (collected.truncated)
        return yield* fail("bodySize", mutation ? "indeterminate" : "response", response.status);
      const body = yield* decodeJson(collected.text).pipe(
        Effect.mapError(() => fail("decode", mutation ? "indeterminate" : "response")),
      );
      return { body, continuation: response.headers["x-ms-continuationtoken"] ?? null };
    });

    const captureFresh = Effect.fnUntraced(function* (key: string) {
      const decoded = yield* Schema.decodeUnknownEffect(captureKeyCodec)(key).pipe(
        Effect.mapError(() => fail("configuration", "configuration")),
      );
      const address = yield* resolveAddress(decoded);
      const now = yield* Clock.currentTimeMillis;
      if ((pausedUntil.get(key) ?? 0) > now)
        return yield* new AzureServerError({
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
        const connection = decodeConnection((yield* getJson(session, "_apis/connectionData")).body);
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
    const acquisitionFlights = new Map<string, Deferred.Deferred<Session, AzureServerError>>();
    const capture = (key: string) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const held = acquisitionFlights.get(key);
          if (held !== undefined) return yield* restore(Deferred.await(held));
          if (acquisitionFlights.size >= 128) return yield* fail("authenticate", "transport");
          const completion = yield* Deferred.make<Session, AzureServerError>();
          acquisitionFlights.set(key, completion);
          const result = yield* restore(captureFresh(key)).pipe(Effect.exit);
          acquisitionFlights.delete(key);
          yield* Deferred.done(completion, result);
          return yield* restore(Deferred.await(completion));
        }),
      );

    const withSession = <A, E, R>(
      input: ReadInput,
      use: (session: AzureSession) => Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | AzureServerError, R> =>
      Effect.gen(function* () {
        const pinned = yield* PinnedSessions;
        const held = pinned.get(input.cwd);
        const session =
          held !== undefined && (input.remoteUrl === undefined || held.cloneUrl === input.remoteUrl)
            ? held
            : yield* resolveAddress(input).pipe(
                Effect.flatMap((address) =>
                  capture(jsonString({ cwd: input.cwd, remoteUrl: address.originalUrl })),
                ),
              );
        const holder: { session: Session | undefined } = { session };
        const { viewer, credentialFingerprint, address } = session;
        const request: Request = (route, options = {}) =>
          Effect.suspend(() =>
            holder.session !== undefined
              ? getJson(
                  holder.session,
                  route,
                  options.query,
                  options.maxBytes,
                  options.method,
                  options.body,
                  options.version,
                  options.contentType,
                  options.mutation,
                )
              : Effect.fail(fail("session", "closed")),
          );
        const capability: AzureSession = {
          viewer,
          credentialFingerprint,
          address,
          executeUnknown: (operation, value) =>
            Effect.suspend(() =>
              holder.session !== undefined
                ? executeUnknownOperation(operation, value, {
                    request,
                    access,
                    viewer,
                    credentialFingerprint,
                    address,
                  })
                : Effect.fail(fail("session", "closed")),
            ),
          execute: (operation, value) =>
            Effect.suspend(() =>
              holder.session !== undefined
                ? executeOperation(operation, value, {
                    request,
                    access,
                    viewer,
                    credentialFingerprint,
                    address,
                  })
                : Effect.fail(fail("session", "closed")),
            ),
        };
        return yield* use(capability).pipe(
          Effect.provideService(PinnedSessions, new Map([...pinned, [input.cwd, session]])),
          Effect.ensuring(
            Effect.sync(() => {
              holder.session = undefined;
            }),
          ),
        );
      });
    const execute = (input: ReadInput, name: string, value: unknown) =>
      Effect.gen(function* () {
        if (!isOperationName(name)) return yield* fail("operation", "unsupported");
        if (access === "read" && !operationIsRead(name)) return yield* fail("access", "denied");
        yield* validateOperationInput(name, value);
        return yield* withSession(input, (session) => session.executeUnknown(name, value));
      });
    return { withSession, resolveAddress, execute };
  });
export type AzureServerClient = Effect.Success<ReturnType<typeof makeAzureServerClient>>;
