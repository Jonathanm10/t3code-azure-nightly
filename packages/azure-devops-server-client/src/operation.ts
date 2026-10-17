// @effect-diagnostics-next-line nodeBuiltinImport:off -- Cursor signatures are process-local keyed capabilities.
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AzureServerError } from "./errors.ts";
import type { WriteReceipt } from "./receipts.ts";
import type { OperationContext } from "./transport.ts";

export const parse = <T>(schema: Schema.ConstraintDecoder<T>, value: unknown) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new AzureServerError({ operation: "decode", category: "response" })),
  );
export const read = <T>(
  context: OperationContext,
  route: string,
  schema: Schema.ConstraintDecoder<T>,
  query: Readonly<Record<string, string>> = {},
  version = "6.0",
) =>
  context
    .request(route, { query, version })
    .pipe(Effect.flatMap((result) => parse(schema, result.body)));
export const segment = encodeURIComponent;
export const projectRoute = (project: string) => `${segment(project)}/_apis`;
export const workItemRoute = (input: { project: string; id: number }) =>
  `${projectRoute(input.project)}/wit/workitems/${input.id}`;
export const repositoryRoute = (input: { project: string; repository: string }) =>
  `${projectRoute(input.project)}/git/repositories/${segment(input.repository)}`;
export const pullRequestRoute = (input: {
  project: string;
  repository: string;
  pullRequestId: number;
}) => `${repositoryRoute(input)}/pullRequests/${input.pullRequestId}`;
export const teamRoute = (input: { project: string; team: string }) =>
  `${segment(input.project)}/${segment(input.team)}/_apis/work`;
export const boardRoute = (input: { project: string; team: string; board: string }) =>
  `${teamRoute(input)}/boards/${segment(input.board)}`;

export function define<I, O>(
  input: Schema.ConstraintDecoder<I>,
  output: Schema.ConstraintDecoder<O>,
  metadata: {
    description: string;
    idempotent?: boolean;
    destructive?: boolean;
    reconcile?: string;
  } & (
    | { readOnly: true }
    | { readOnly: false; receipt: (input: I, output: O, collection: string) => WriteReceipt }
  ),
  handler: (input: I, context: OperationContext) => Effect.Effect<O, AzureServerError>,
) {
  const decodeInput = Schema.decodeUnknownEffect(input);
  const receiptInput = Schema.decodeUnknownSync(input);
  const receiptOutput = Schema.decodeUnknownSync(output);
  return {
    validate: (value: unknown) =>
      decodeInput(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () => new AzureServerError({ operation: "input", category: "configuration" }),
        ),
      ),
    input,
    output,
    ...metadata,
    receipt: (value: unknown, result: unknown, collection: string) =>
      metadata.readOnly
        ? null
        : metadata.receipt(receiptInput(value), receiptOutput(result), collection),
    run: (value: unknown, context: OperationContext) => {
      if (!metadata.readOnly && context.access === "read")
        return Effect.fail(new AzureServerError({ operation: "access", category: "denied" }));
      return decodeInput(value, { onExcessProperty: "error" }).pipe(
        Effect.mapError(
          () => new AzureServerError({ operation: "input", category: "configuration" }),
        ),
        Effect.flatMap((decoded) => handler(decoded, context)),
        Effect.flatMap((result) => parse(output, result)),
      );
    },
  };
}
const Cursor = Schema.Struct({
  binding: Schema.String,
  token: Schema.String,
  signature: Schema.String,
});
const parseCursor = Schema.decodeEffect(Schema.fromJsonString(Cursor));
const cursorBinding = (
  context: OperationContext,
  route: string,
  query: Readonly<Record<string, string>>,
) =>
  JSON.stringify([
    context.address.canonicalKey,
    context.address.originalUrl,
    context.credentialFingerprint,
    route,
    Object.entries(query).sort(),
  ]);
const signature = (context: OperationContext, binding: string, token: string) =>
  NodeCrypto.createHmac("sha256", context.credentialFingerprint)
    .update(JSON.stringify([binding, token]))
    .digest("hex");
export const encodeCursor = (
  context: OperationContext,
  route: string,
  query: Readonly<Record<string, string>>,
  token: string,
) => {
  const binding = cursorBinding(context, route, query);
  return Buffer.from(
    JSON.stringify({ binding, token, signature: signature(context, binding, token) }),
  ).toString("base64url");
};
export const decodeCursor = (
  context: OperationContext,
  route: string,
  query: Readonly<Record<string, string>>,
  cursor: string | undefined,
) =>
  Effect.gen(function* () {
    if (cursor === undefined) return null;
    const decoded = yield* parseCursor(Buffer.from(cursor, "base64url").toString("utf8")).pipe(
      Effect.mapError(
        () => new AzureServerError({ operation: "cursor", category: "configuration" }),
      ),
    );
    if (
      decoded.binding !== cursorBinding(context, route, query) ||
      decoded.signature !== signature(context, decoded.binding, decoded.token)
    )
      return yield* new AzureServerError({ operation: "cursor", category: "configuration" });
    return decoded.token;
  });
export const page = <T>(
  context: OperationContext,
  route: string,
  schema: Schema.ConstraintDecoder<T>,
  input: { limit?: number; cursor?: string },
  options: {
    query?: Readonly<Record<string, string>>;
    mode?: "token" | "skip" | "local";
    version?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const limit = input.limit ?? 100;
    const query = { ...options.query, $top: String(limit) };
    const token = yield* decodeCursor(context, route, query, input.cursor);
    const mode = options.mode ?? "local";
    const result = yield* context.request(route, {
      query: {
        ...query,
        ...(token === null || mode === "local"
          ? {}
          : { [mode === "skip" ? "$skip" : "continuationToken"]: token }),
      },
      version: options.version ?? "6.0",
    });
    const decoded = yield* parse(Schema.Struct({ value: Schema.Array(schema) }), result.body);
    if (decoded.value.length > 10000)
      return yield* new AzureServerError({ operation: "page", category: "response" });
    const offset = mode === "local" ? Number(token ?? 0) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 10000)
      return yield* new AzureServerError({ operation: "cursor", category: "configuration" });
    const items = decoded.value.slice(offset, offset + limit);
    const nextToken =
      mode === "local"
        ? offset + limit < decoded.value.length
          ? String(offset + limit)
          : null
        : (result.continuation ??
          (mode === "skip" && decoded.value.length >= limit
            ? String(Number(token ?? 0) + limit)
            : null));
    if (decoded.value.length > limit && mode === "token")
      return yield* new AzureServerError({ operation: "pageLimit", category: "response" });
    return {
      items,
      next: nextToken === null ? null : encodeCursor(context, route, query, nextToken),
    };
  });
export const mutation = <T>(
  context: OperationContext,
  route: string,
  schema: Schema.ConstraintDecoder<T>,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  body?: unknown,
  version = "6.0",
  contentType = "application/json",
) =>
  context
    .request(route, { method, body, version, contentType, mutation: true })
    .pipe(
      Effect.flatMap((response) =>
        parse(schema, response.body).pipe(
          Effect.mapError(
            () => new AzureServerError({ operation: "decodeWrite", category: "indeterminate" }),
          ),
        ),
      ),
    );
