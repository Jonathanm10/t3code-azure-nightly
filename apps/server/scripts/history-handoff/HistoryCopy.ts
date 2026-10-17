// @effect-diagnostics nodeBuiltinImport:off - This one-time operator composes scoped SQL services with native read-only capture and durable directory publication.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Option from "effect/Option";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  EventId,
  OrchestrationV2DomainEventJson,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../src/persistence/Migrations.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import * as ApplicationEvents from "../../src/persistence/OrchestrationEventStore.ts";
import {
  historyLayer,
  hydrateLegacyHistory,
  freezeHistory,
  assertHistoryInert,
} from "./HistoryFreeze.ts";
import { HistoryFreezeRefused, openHistoryFreezeJournal } from "./HistoryFreezeJournal.ts";
import { HistoryAssetRefused } from "./HistoryAssets.ts";
import { HistorySchemaRefused, assertDestinationHistorySchema } from "./HistoryCapturePolicy.ts";
import { historyTables } from "./HistoryCapturePolicy.ts";
import {
  captureRows,
  captureAssets,
  openCaptureJournal,
  inventoryAssetCandidates,
  tableDigest,
  recordReferences,
  HistoryCaptureRefused,
} from "./HistoryCapture.ts";
import { relocateHistoryValue, historyReferences } from "./HistoryReferences.ts";
import {
  claimHistoryOperation,
  restartOwnedStage,
  persistOperation,
  packageDigest,
  recognizeInstalled,
  publishHistory,
  syncDirectory,
  type HistoryOperation,
} from "./HistoryPublication.ts";

const isCaptureRefused = Schema.is(HistoryCaptureRefused);
const knownRefusal = Schema.is(
  Schema.Union([
    HistoryCaptureRefused,
    HistoryAssetRefused,
    HistorySchemaRefused,
    HistoryFreezeRefused,
  ]),
);
const diagnosticInteger = Schema.Int.check(
  Schema.isBetween({ minimum: -2_147_483_648, maximum: 2_147_483_647 }),
);
const decodeRefusalDiagnostic = Schema.decodeUnknownOption(
  Schema.Struct({
    name: Schema.Literals(["Error", "TypeError", "RangeError", "SystemError"]),
    code: Schema.Literals([
      "ERR_SQLITE_ERROR",
      "EACCES",
      "EBUSY",
      "ECANCELED",
      "EDQUOT",
      "EEXIST",
      "EFBIG",
      "EINVAL",
      "EIO",
      "EISDIR",
      "ELOOP",
      "EMFILE",
      "ENAMETOOLONG",
      "ENFILE",
      "ENOENT",
      "ENOSPC",
      "ENOSYS",
      "ENOTDIR",
      "ENOTEMPTY",
      "ENOTSUP",
      "EPERM",
      "EROFS",
      "EXDEV",
    ]),
    errno: Schema.optionalKey(diagnosticInteger),
    errcode: Schema.optionalKey(diagnosticInteger),
  }),
);
function refusalDiagnostic(cause: unknown) {
  for (let depth = 0; depth < 4 && isCaptureRefused(cause); depth++) cause = cause.cause;
  const decoded = decodeRefusalDiagnostic(cause);
  if (Option.isNone(decoded)) return undefined;
  const { name, code, errno, errcode } = decoded.value;
  return {
    name,
    code,
    ...(errno === undefined ? {} : { errno }),
    ...(errcode === undefined ? {} : { errcode }),
  };
}
function refusalEntity(cause: unknown) {
  if (!knownRefusal(cause)) return undefined;
  switch (cause._tag) {
    case "HistoryCaptureRefused":
      return cause.entity;
    case "HistoryAssetRefused":
      return cause.reference;
    case "HistorySchemaRefused":
      return cause.table;
    case "HistoryFreezeRefused":
      return cause.entityId;
  }
}
function captureError(cause: unknown, fallback: string) {
  const entity = refusalEntity(cause);
  return new HistoryCaptureRefused({
    reason: knownRefusal(cause) ? cause.reason : fallback,
    ...(entity === undefined ? {} : { entity }),
    cause,
  });
}
const io = <A>(body: () => Promise<A>) =>
  Effect.tryPromise({ try: body, catch: (cause) => captureError(cause, "io-failure") });
const sync = <A>(body: () => A) =>
  Effect.try({ try: body, catch: (cause) => captureError(cause, "capture-failure") });
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
function journalInitialized(filename: string) {
  if (!NodeFS.existsSync(filename)) return false;
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='operation'").get() === undefined)
      return false;
    return db.prepare("SELECT 1 FROM operation").get() !== undefined;
  } finally {
    db.close();
  }
}
function auditCapturedProjection(filename: string, journal: NodeSqlite.DatabaseSync) {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    for (const table of currentProjectionTables) {
      const expected = journal
        .prepare("SELECT count,content,identities FROM captured_tables WHERE name=?")
        .get(table.name);
      const actual = tableDigest(db, table.name);
      if (
        expected?.count !== actual.count ||
        expected.content !== actual.content ||
        expected.identities !== actual.identities
      )
        throw new HistoryCaptureRefused({
          reason: "captured-projection-diverged",
          entity: table.name,
        });
    }
  } finally {
    db.close();
  }
}
const currentProjectionTables = historyTables.filter(
  (table) =>
    table.name === "projection_projects" ||
    table.name === "orchestration_v2_turn_item_positions" ||
    (table.name.startsWith("orchestration_v2_projection_") &&
      table.name !== "orchestration_v2_projection_metadata"),
);
function projectionDigests(filename: string) {
  const database = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    return currentProjectionTables.map((table) => [table.name, tableDigest(database, table.name)]);
  } finally {
    database.close();
  }
}
const rebuild = Effect.gen(function* () {
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  if (!(yield* maintenance.rebuild).valid)
    return yield* new HistoryCaptureRefused({ reason: "rebuild-invalid" });
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects`;
      yield* events
        .readApplicationEvents({
          afterSequence: 0,
          throughSequence: yield* events.latestApplicationSequence,
        })
        .pipe(
          Stream.runForEach((event) =>
            "aggregateKind" in event && event.aggregateKind === "project"
              ? projects.apply(event)
              : Effect.void,
          ),
        );
    }),
  );
}).pipe(Effect.provide(ApplicationEvents.layer));
const verifyRebuild = Effect.fnUntraced(function* (filename: string) {
  const before = yield* sync(() => projectionDigests(filename));
  yield* rebuild;
  const after = yield* sync(() => projectionDigests(filename));
  if (encodeJson(before) !== encodeJson(after))
    return yield* new HistoryCaptureRefused({ reason: "projection-replay-mismatch" });
});

const rebaseHistory = Effect.fnUntraced(function* (
  operation: Extract<HistoryOperation, { phase: "captured" }>,
  journal: NodeSqlite.DatabaseSync,
) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* EventStore.EventStoreV2;
  const assetJournalPath = NodePath.join(operation.operationDirectory, "assets.sqlite");
  if (!(yield* sync(() => journalInitialized(assetJournalPath)))) {
    yield* sync(() =>
      auditCapturedProjection(
        NodePath.join(operation.stage, "userdata", "statev2.sqlite"),
        journal,
      ),
    );
  }
  const now = DateTime.makeUnsafe(operation.frozenAt);
  const audit = yield* openHistoryFreezeJournal({
    operationId: `${operation.id}:assets`,
    frozenAt: now,
    expectedApplicationSequence: operation.captureHead,
    journalPath: NodePath.join(operation.operationDirectory, "assets.sqlite"),
  });
  yield* Effect.acquireRelease(
    sql`ATTACH DATABASE ${NodePath.join(operation.operationDirectory, "capture.sqlite")} AS capture_evidence`,
    () => sql`DETACH DATABASE capture_evidence`.pipe(Effect.orDie),
  );
  const relocate = (path: string) => {
    const row = journal
      .prepare("SELECT target,status FROM asset_references WHERE path=?")
      .get(path);
    if (row === undefined) return undefined;
    if (row.status !== "copied" || typeof row.target !== "string")
      throw new HistoryCaptureRefused({ reason: "required-asset-unavailable", entity: path });
    return row.target;
  };
  for (const table of [
    { name: "orchestration_v2_projection_messages", key: "message_id", event: "message.updated" },
    {
      name: "orchestration_v2_projection_turn_items",
      key: "turn_item_id",
      event: "turn-item.updated",
    },
  ] as const) {
    let after = "";
    for (;;) {
      const rows = yield* sql<{
        id: string;
        thread_id: string;
        payload_json: string;
      }>`SELECT ${sql(table.key)} AS id, thread_id, payload_json FROM ${sql(table.name)} WHERE ${sql(table.key)} > ${after} ORDER BY ${sql(table.key)} LIMIT 32`;
      if (rows.length === 0) break;
      for (const row of rows) {
        const original = yield* decodeJson(row.payload_json);
        yield* sync(() =>
          recordReferences({
            value: original,
            required: true,
            sourceState: operation.sourceState,
            journal,
            structuredTools: table.event === "turn-item.updated",
            countOccurrence: false,
          }),
        );
        const relocated = yield* sync(() =>
          relocateHistoryValue(original, relocate, table.event === "turn-item.updated"),
        );
        after = row.id;
        if (relocated.changes.length === 0) continue;
        const event = yield* decodeEvent({
          id: EventId.make(`history-assets:${operation.id}:${table.name}:${row.id}`),
          threadId: row.thread_id,
          occurredAt: operation.frozenAt,
          type: table.event,
          payload: relocated.value,
        });
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const affected = yield* audit.verifyThreadBatch([event]);
            yield* sink.commitCommand({
              commandId: CommandId.make(event.id),
              threadId: ThreadId.make(row.thread_id),
              commandType: "history.asset-relocation",
              acceptedAt: now,
              events: [event],
              effects: [],
            });
            yield* affected.checkpoint;
            yield* sql`UPDATE history_handoff.operation SET current_head = ${yield* store.latestApplicationSequence}`;
            yield* sql`INSERT INTO capture_evidence.rebases VALUES (${`${table.name}:${row.id}`}, ${row.payload_json}, ${encodeJson(relocated.value)})`;
          }),
        );
      }
    }
  }
  let afterProject = "";
  for (;;) {
    const projects = yield* sql<{
      project_id: string;
      favicon_path: string;
    }>`SELECT project_id,favicon_path FROM projection_projects WHERE favicon_path IS NOT NULL AND project_id > ${afterProject} ORDER BY project_id LIMIT 32`;
    if (projects.length === 0) break;
    for (const project of projects) {
      afterProject = project.project_id;
      const destination = relocate(project.favicon_path);
      if (destination === undefined) continue;
      const projectId = ProjectId.make(project.project_id);
      const commandId = CommandId.make(`history-assets:${operation.id}:project:${projectId}`);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          const affected = yield* audit.verifyProject(projectId);
          yield* sink.commitProjectCommand({
            commandId,
            projectId,
            commandType: "history.asset-relocation",
            acceptedAt: now,
            event: {
              eventId: EventId.make(commandId),
              aggregateKind: "project",
              aggregateId: projectId,
              occurredAt: operation.frozenAt,
              commandId,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              type: "project.meta-updated",
              payload: { projectId, faviconPath: destination, updatedAt: operation.frozenAt },
            },
          });
          yield* affected.checkpoint;
          yield* sql`UPDATE history_handoff.operation SET current_head = ${yield* store.latestApplicationSequence}`;
          yield* sql`INSERT INTO capture_evidence.rebases VALUES (${`project:${projectId}`}, ${encodeJson({ faviconPath: project.favicon_path })}, ${encodeJson({ faviconPath: destination })})`;
        }),
      );
    }
  }
  for (const table of historyTables.filter(
    (table) =>
      table.name.startsWith("orchestration_v2_projection_") &&
      table.columns.some((column) => column === "payload_json") &&
      !["orchestration_v2_projection_messages", "orchestration_v2_projection_turn_items"].includes(
        table.name,
      ),
  )) {
    let after = "";
    const key = table.columns[0];
    for (;;) {
      const rows = yield* sql<{
        id: string;
        payload_json: string;
      }>`SELECT ${sql(key)} AS id,payload_json FROM ${sql(table.name)} WHERE ${sql(key)} > ${after} ORDER BY ${sql(key)} LIMIT 32`;
      if (rows.length === 0) break;
      for (const row of rows) {
        const value = yield* decodeJson(row.payload_json);
        const references = yield* sync(() => historyReferences(value));
        if (references.paths.some((path) => path.startsWith(`${operation.sourceState}/`)))
          return yield* new HistoryCaptureRefused({
            reason: "unsupported-current-reference-owner",
            entity: `${table.name}:${row.id}`,
          });
        after = row.id;
      }
    }
  }
  const missing = journal
    .prepare("SELECT path FROM asset_references WHERE required=1 AND status!='copied' LIMIT 1")
    .get();
  if (missing !== undefined)
    return yield* new HistoryCaptureRefused({ reason: "required-asset-unavailable" });
  yield* audit.finish;
}, Effect.scoped);

const withHistory = (filename: string) =>
  historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
const originalPrefix = (filename: string, head: number) => {
  const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
  try {
    return tableDigest(db, "orchestration_events", { through: head });
  } finally {
    db.close();
  }
};

export const copyHistory = Effect.fn("history-handoff.copyHistory")(
  function* (input: {
    readonly sourceState: string;
    readonly targetHome: string;
    readonly operationDirectory: string;
  }) {
    const claimed = yield* Effect.acquireRelease(
      io(() => claimHistoryOperation(input)),
      (claim) => Effect.promise(claim.release),
    );
    return yield* Effect.gen(function* () {
      let operation = claimed.operation;
      const journalPath = NodePath.join(operation.operationDirectory, "capture.sqlite");
      if (operation.phase === "capturing") {
        yield* io(() => restartOwnedStage(operation));
        yield* io(() => NodeFSP.rm(journalPath, { force: true }));
      }
      const journal = yield* Effect.acquireRelease(
        sync(() => openCaptureJournal(journalPath)),
        (db) => Effect.sync(() => db.close()),
      );
      if (yield* io(() => recognizeInstalled(operation, journal))) {
        if (operation.phase !== "ready" && operation.phase !== "installed")
          return yield* new HistoryCaptureRefused({ reason: "invalid-installed-phase" });
        const installed = { ...operation, phase: "installed" as const };
        yield* io(() => persistOperation(installed));
        return { kind: "already-installed" as const, receipt: installed };
      }
      const filename = NodePath.join(operation.stage, "userdata", "statev2.sqlite");
      if (operation.phase === "capturing") {
        const sourceInfo = yield* io(() =>
          NodeFSP.stat(NodePath.join(operation.sourceState, "statev2.sqlite")),
        );
        const capacity = yield* io(() => NodeFSP.statfs(NodePath.dirname(operation.stage)));
        if (capacity.bavail * capacity.bsize < sourceInfo.size * 3)
          return yield* new HistoryCaptureRefused({ reason: "insufficient-stage-space" });
        yield* runMigrations().pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
        yield* sync(() => {
          const db = new NodeSqlite.DatabaseSync(filename);
          try {
            db.exec("ALTER TABLE projection_turns ADD COLUMN reasoning_json TEXT");
          } finally {
            db.close();
          }
        });
        yield* io(() => inventoryAssetCandidates(operation.sourceState, journal));
        const cut = yield* sync(() =>
          captureRows({
            sourcePath: NodePath.join(operation.sourceState, "statev2.sqlite"),
            destinationPath: filename,
            journal,
            sourceState: operation.sourceState,
          }),
        );
        const hostHome = yield* HostProcess.HomeDirectory;
        yield* io(async () => {
          const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          try {
            for (const row of db
              .prepare("SELECT project_id,workspace_root FROM projection_projects")
              .iterate()) {
              if (typeof row.project_id === "string" && typeof row.workspace_root === "string")
                journal
                  .prepare("INSERT INTO external_dependencies VALUES (?, ?, ?, ?)")
                  .run(
                    `project:${row.project_id}:workspace`,
                    row.workspace_root,
                    row.workspace_root,
                    "uninspected-workspace-dependency",
                  );
            }
            for (const row of db
              .prepare(
                "SELECT thread_id,worktree_path FROM projection_threads WHERE worktree_path IS NOT NULL",
              )
              .iterate()) {
              if (typeof row.thread_id === "string" && typeof row.worktree_path === "string")
                journal
                  .prepare("INSERT INTO external_dependencies VALUES (?, ?, ?, ?)")
                  .run(
                    `legacy:${row.thread_id}:worktree`,
                    row.worktree_path,
                    row.worktree_path,
                    "uninspected-worktree-dependency",
                  );
            }
            for (const row of db
              .prepare(
                "SELECT checkpoint_id,json_extract(payload_json,'$.ref') AS ref FROM orchestration_v2_projection_checkpoints",
              )
              .iterate()) {
              if (typeof row.checkpoint_id === "string" && typeof row.ref === "string")
                journal
                  .prepare("INSERT INTO external_dependencies VALUES (?, ?, ?, ?)")
                  .run(
                    `checkpoint:${row.checkpoint_id}`,
                    row.ref,
                    row.ref,
                    "uninspected-vcs-object-dependency",
                  );
            }
            for (const row of db
              .prepare(
                "SELECT project_id,workspace_root,favicon_path FROM projection_projects WHERE favicon_path IS NOT NULL",
              )
              .iterate()) {
              if (
                typeof row.project_id !== "string" ||
                typeof row.workspace_root !== "string" ||
                typeof row.favicon_path !== "string"
              )
                throw new HistoryCaptureRefused({ reason: "invalid-project-icon" });
              if (row.favicon_path === PROJECT_FAVICON_FALLBACK_MARKER) {
                journal
                  .prepare("INSERT INTO external_dependencies VALUES (?, ?, ?, ?)")
                  .run(
                    row.project_id,
                    row.favicon_path,
                    row.favicon_path,
                    "generated-fallback-icon",
                  );
                continue;
              }
              const resolved = NodePath.resolve(
                expandHomePath(row.workspace_root, hostHome),
                expandHomePath(row.favicon_path, hostHome),
              );
              if (resolved.startsWith(`${operation.sourceState}/`)) {
                if (
                  !["attachments", "browser-artifacts"].some((directory) =>
                    resolved.startsWith(`${NodePath.join(operation.sourceState, directory)}/`),
                  )
                )
                  throw new HistoryCaptureRefused({ reason: "profile-icon-needs-proved-file-cut" });
                recordReferences({
                  value: { screenshotPath: resolved },
                  required: true,
                  sourceState: operation.sourceState,
                  journal,
                });
                continue;
              }
              let status = "missing-mutable-external-dependency";
              try {
                const stat = await NodeFSP.lstat(resolved);
                status = stat.isFile()
                  ? "regular-mutable-external-dependency"
                  : stat.isSymbolicLink()
                    ? "symlink-mutable-external-dependency"
                    : "nonregular-mutable-external-dependency";
              } catch (cause) {
                if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT"))
                  throw cause;
              }
              journal
                .prepare("INSERT INTO external_dependencies VALUES (?, ?, ?, ?)")
                .run(row.project_id, row.favicon_path, resolved, status);
            }
          } finally {
            db.close();
          }
        });
        yield* io(() =>
          captureAssets({
            sourceState: operation.sourceState,
            stageState: NodePath.join(operation.stage, "userdata"),
            targetState: NodePath.join(operation.targetHome, "userdata"),
            journal,
          }),
        );
        yield* verifyRebuild(filename).pipe(Effect.provide(withHistory(filename)));
        const captureHead = yield* Effect.gen(function* () {
          yield* hydrateLegacyHistory();
          return yield* (yield* EventStore.EventStoreV2).latestApplicationSequence;
        }).pipe(Effect.provide(withHistory(filename)));
        yield* sync(() => {
          const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          try {
            for (const table of historyTables.filter(
              (table) => table.disposition === "copy-history",
            )) {
              const digest = tableDigest(db, table.name);
              journal
                .prepare("INSERT INTO captured_tables VALUES (?, ?, ?, ?)")
                .run(table.name, digest.count, digest.content, digest.identities);
            }
          } finally {
            db.close();
          }
        });
        operation = {
          ...operation,
          phase: "captured",
          cut,
          captureHead,
          frozenAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
        yield* io(() => persistOperation(operation));
      }
      if (operation.phase === "captured") {
        const captured = operation;
        const head = yield* Effect.gen(function* () {
          yield* rebaseHistory(captured, journal);
          return yield* (yield* EventStore.EventStoreV2).latestApplicationSequence;
        }).pipe(Effect.provide(withHistory(filename)));
        operation = { ...captured, phase: "prepared", freezeHead: head };
        yield* io(() => persistOperation(operation));
      }
      if (operation.phase === "prepared") {
        const prepared = operation;
        yield* Effect.gen(function* () {
          if (
            !(yield* sync(() =>
              journalInitialized(NodePath.join(prepared.operationDirectory, "freeze.sqlite")),
            ))
          ) {
            yield* Effect.scoped(
              openHistoryFreezeJournal({
                operationId: `${prepared.id}:assets`,
                frozenAt: DateTime.makeUnsafe(prepared.frozenAt),
                expectedApplicationSequence: prepared.captureHead,
                journalPath: NodePath.join(prepared.operationDirectory, "assets.sqlite"),
              }),
            );
          }
          yield* freezeHistory({
            operationId: prepared.id,
            frozenAt: DateTime.makeUnsafe(prepared.frozenAt),
            expectedApplicationSequence: prepared.freezeHead,
            journalPath: NodePath.join(prepared.operationDirectory, "freeze.sqlite"),
          });
          yield* verifyRebuild(filename);
          yield* verifyRebuild(filename);
          yield* assertHistoryInert(DateTime.makeUnsafe(prepared.frozenAt));
        }).pipe(Effect.provide(withHistory(filename)));
        const expected = journal
          .prepare(
            "SELECT count,content,identities FROM source_tables WHERE name='orchestration_events'",
          )
          .get();
        const prefix = yield* sync(() =>
          originalPrefix(filename, prepared.cut.applicationSequence),
        );
        if (
          expected?.count !== prefix.count ||
          expected.content !== prefix.content ||
          expected.identities !== prefix.identities
        )
          return yield* new HistoryCaptureRefused({ reason: "source-prefix-changed" });
        yield* sync(() => {
          const db = new NodeSqlite.DatabaseSync(filename, { readOnly: true });
          try {
            assertDestinationHistorySchema(db);
            for (const table of historyTables.filter(
              (table) =>
                table.disposition === "empty-operational" &&
                table.name !== "orchestration_command_receipts",
            )) {
              if (db.prepare(`SELECT 1 FROM "${table.name}" LIMIT 1`).get() !== undefined)
                throw new HistoryCaptureRefused({
                  reason: "excluded-store-not-empty",
                  entity: table.name,
                });
            }
            const commands = new Map<string, { type: string; head?: number }>();
            for (const row of journal.prepare("SELECT entity FROM rebases").iterate()) {
              if (typeof row.entity !== "string")
                throw new HistoryCaptureRefused({ reason: "invalid-rebase-receipt" });
              commands.set(`history-assets:${prepared.id}:${row.entity}`, {
                type: "history.asset-relocation",
              });
            }
            const freezeJournal = new NodeSqlite.DatabaseSync(
              NodePath.join(prepared.operationDirectory, "freeze.sqlite"),
              { readOnly: true },
            );
            try {
              for (const row of freezeJournal
                .prepare("SELECT command_id,result_head FROM batches")
                .iterate()) {
                if (typeof row.command_id !== "string" || typeof row.result_head !== "number")
                  throw new HistoryCaptureRefused({ reason: "invalid-freeze-receipt" });
                commands.set(row.command_id, {
                  type: "history.copy-freeze",
                  head: row.result_head,
                });
              }
            } finally {
              freezeJournal.close();
            }
            for (const receipt of db
              .prepare("SELECT * FROM orchestration_command_receipts")
              .iterate()) {
              if (typeof receipt.command_id !== "string")
                throw new HistoryCaptureRefused({ reason: "unowned-or-changed-command-receipt" });
              const expected = commands.get(receipt.command_id);
              const event = db
                .prepare(
                  "SELECT * FROM orchestration_events WHERE command_id=? ORDER BY sequence DESC LIMIT 1",
                )
                .get(receipt.command_id);
              if (
                expected === undefined ||
                event === undefined ||
                receipt.command_type !== expected.type ||
                receipt.accepted_at !== prepared.frozenAt ||
                receipt.status !== "accepted" ||
                receipt.error !== null ||
                receipt.aggregate_kind !== event.aggregate_kind ||
                receipt.aggregate_id !== event.stream_id ||
                receipt.result_sequence !== event.sequence ||
                (expected.head !== undefined && receipt.result_sequence !== expected.head)
              )
                throw new HistoryCaptureRefused({ reason: "unowned-or-changed-command-receipt" });
              commands.delete(String(receipt.command_id));
            }
            if (commands.size > 0)
              throw new HistoryCaptureRefused({ reason: "missing-generated-command-receipt" });
            for (const table of historyTables.filter(
              (table) =>
                table.disposition === "copy-history" &&
                !currentProjectionTables.some((projection) => projection.name === table.name) &&
                !["orchestration_events", "orchestration_v2_projection_metadata"].includes(
                  table.name,
                ),
            )) {
              const expected = journal
                .prepare("SELECT count,content,identities FROM captured_tables WHERE name=?")
                .get(table.name);
              const actual = tableDigest(db, table.name);
              if (
                expected?.count !== actual.count ||
                expected.content !== actual.content ||
                expected.identities !== actual.identities
              )
                throw new HistoryCaptureRefused({
                  reason: "retained-history-changed",
                  entity: table.name,
                });
            }
          } finally {
            db.close();
          }
        });
        if (
          (yield* io(() =>
            NodeFSP.readFile(NodePath.join(prepared.stage, ".history-owner"), "utf8"),
          )) !== prepared.id
        )
          return yield* new HistoryCaptureRefused({ reason: "stage-owner-mismatch" });
        const digest = yield* io(() =>
          packageDigest(prepared.stage, journal, { targetHome: prepared.targetHome }),
        );
        yield* sync(() => {
          for (const asset of journal
            .prepare("SELECT target,sha256 FROM asset_references WHERE status='copied'")
            .iterate()) {
            if (
              typeof asset.target !== "string" ||
              !asset.target.startsWith(`${prepared.targetHome}/`)
            )
              throw new HistoryCaptureRefused({ reason: "invalid-captured-asset-target" });
            const path = NodePath.relative(prepared.targetHome, asset.target);
            if (
              journal.prepare("SELECT sha256 FROM package_files WHERE path=?").get(path)?.sha256 !==
              asset.sha256
            )
              throw new HistoryCaptureRefused({ reason: "captured-asset-diverged" });
          }
        });
        operation = { ...prepared, phase: "ready", packageHash: digest };
        yield* io(() => persistOperation(operation));
      }
      if (operation.phase !== "ready")
        return yield* new HistoryCaptureRefused({ reason: "invalid-publication-phase" });
      const ready = operation;
      if ((yield* io(() => packageDigest(ready.stage, journal, false))) !== ready.packageHash)
        return yield* new HistoryCaptureRefused({ reason: "stage-diverged" });
      const platform = yield* HostProcess.Platform;
      yield* io(() => publishHistory(ready, platform)).pipe(Effect.uninterruptible);
      const installed = { ...ready, phase: "installed" as const };
      yield* io(() => persistOperation(installed));
      return { kind: "installed" as const, receipt: installed };
    }).pipe(
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const reason = knownRefusal(cause) ? cause.reason : "history-validation-failed";
          const diagnostic = refusalDiagnostic(cause);
          const receiptPath = NodePath.join(claimed.operation.operationDirectory, "refusal.json");
          const receipt = yield* io(async () => {
            const handle = await NodeFSP.open(receiptPath, "w", 0o600);
            try {
              await handle.writeFile(
                encodeJson({
                  version: 1,
                  operationId: claimed.operation.id,
                  reason,
                  ...(refusalEntity(cause) === undefined ? {} : { entity: refusalEntity(cause) }),
                  ...(diagnostic === undefined ? {} : { diagnostic }),
                }),
              );
              await handle.sync();
            } finally {
              await handle.close();
            }
            await syncDirectory(claimed.operation.operationDirectory);
            return receiptPath;
          }).pipe(Effect.option);
          return yield* new HistoryCaptureRefused({
            reason,
            ...(Option.isSome(receipt) ? { receiptPath: receipt.value } : {}),
            cause,
          });
        }),
      ),
    );
  },
  Effect.scoped,
  Effect.catch((cause) =>
    Effect.succeed({
      kind: "refused" as const,
      reason: knownRefusal(cause) ? cause.reason : "history-validation-failed",
      receiptPath: isCaptureRefused(cause) ? (cause.receiptPath ?? null) : null,
    }),
  ),
);
