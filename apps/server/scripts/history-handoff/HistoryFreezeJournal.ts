import * as Crypto from "effect/Crypto";
import {
  OrchestrationV2ProviderSessionJson,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  ThreadId,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";

export class HistoryFreezeRefused extends Schema.TaggedError<HistoryFreezeRefused>()(
  "HistoryFreezeRefused",
  { reason: Schema.String, entityId: Schema.String },
) {
  override get message() {
    return `${this.reason}: ${this.entityId}`;
  }
}

export const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const digest = Effect.fnUntraced(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Buffer.from(yield* crypto.digest("SHA-256", new TextEncoder().encode(value))).toString(
    "hex",
  );
});

const localFields = [
  "runs",
  "attempts",
  "nodes",
  "subagents",
  "providerSessions",
  "providerThreads",
  "providerTurns",
  "runtimeRequests",
  "messages",
  "plans",
  "turnItems",
  "checkpointScopes",
  "checkpoints",
  "contextHandoffs",
  "contextTransfers",
] as const;
const decodeSession = Schema.decodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJson),
);
export const readThread = Effect.fnUntraced(function* (threadId: ThreadId) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const p = yield* projections.getThreadRecords(threadId, localFields);
  const sql = yield* SqlClient.SqlClient;
  const orphanSessions = yield* sql<{
    payload_json: string;
  }>`SELECT payload_json FROM orchestration_v2_projection_provider_sessions session WHERE thread_id = ${threadId} AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_session_bindings binding WHERE binding.provider_session_id = session.provider_session_id)`;
  const sessions = yield* Effect.forEach(orphanSessions, (row) => decodeSession(row.payload_json));
  return {
    ...p,
    providerSessions: [...p.providerSessions, ...sessions],
    updatedAt: p.thread.updatedAt,
    visibleTurnItems: [],
  } satisfies OrchestrationV2ThreadProjection;
});

export const eachThread = Effect.fnUntraced(function* <E, R>(
  f: (id: ThreadId) => Effect.Effect<void, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id > ${after} ORDER BY thread_id LIMIT 32`;
    if (rows.length === 0) return;
    for (const row of rows) {
      yield* f(ThreadId.make(row.thread_id));
      after = row.thread_id;
    }
  }
});

const tables = {
  projects: { name: "projection_projects", keys: ["project_id"] },
  threads: { name: "orchestration_v2_projection_threads", keys: ["thread_id"] },
  runs: { name: "orchestration_v2_projection_runs", keys: ["run_id"] },
  attempts: { name: "orchestration_v2_projection_run_attempts", keys: ["attempt_id"] },
  nodes: { name: "orchestration_v2_projection_nodes", keys: ["node_id"] },
  subagents: { name: "orchestration_v2_projection_subagents", keys: ["subagent_id"] },
  sessions: {
    name: "orchestration_v2_projection_provider_sessions",
    keys: ["provider_session_id"],
  },
  bindings: {
    name: "orchestration_v2_projection_provider_session_bindings",
    keys: ["provider_session_id", "thread_id"],
  },
  providerThreads: {
    name: "orchestration_v2_projection_provider_threads",
    keys: ["provider_thread_id"],
  },
  turns: { name: "orchestration_v2_projection_provider_turns", keys: ["provider_turn_id"] },
  requests: { name: "orchestration_v2_projection_runtime_requests", keys: ["runtime_request_id"] },
  messages: { name: "orchestration_v2_projection_messages", keys: ["message_id"] },
  plans: { name: "orchestration_v2_projection_plans", keys: ["plan_id"] },
  items: { name: "orchestration_v2_projection_turn_items", keys: ["turn_item_id"] },
  positions: { name: "orchestration_v2_turn_item_positions", keys: ["thread_id", "turn_item_id"] },
  scopes: { name: "orchestration_v2_projection_checkpoint_scopes", keys: ["scope_id"] },
  checkpoints: { name: "orchestration_v2_projection_checkpoints", keys: ["checkpoint_id"] },
  handoffs: { name: "orchestration_v2_projection_context_handoffs", keys: ["context_handoff_id"] },
  transfers: {
    name: "orchestration_v2_projection_context_transfers",
    keys: ["context_transfer_id"],
  },
} as const;
type ProjectionTable = (typeof tables)[keyof typeof tables];
type ProjectionRow = { readonly table: ProjectionTable; readonly key: string };

export const openHistoryFreezeJournal = Effect.fnUntraced(function* (input: {
  readonly operationId: string;
  readonly frozenAt: DateTime.Utc;
  readonly expectedApplicationSequence: number;
  readonly journalPath: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* EventStore.EventStoreV2;
  const refuse = (reason: string, entityId: string) =>
    new HistoryFreezeRefused({ reason, entityId });
  const mainMode = yield* sql<{ journal_mode: string }>`PRAGMA main.journal_mode`;
  const mainSync = yield* sql<{ synchronous: number }>`PRAGMA main.synchronous`;
  if (mainMode[0]?.journal_mode !== "delete" || (mainSync[0]?.synchronous ?? 0) < 2)
    return yield* refuse("unsupported-journal-mode", "destination");
  yield* Effect.acquireRelease(sql`ATTACH DATABASE ${input.journalPath} AS history_handoff`, () =>
    sql`DETACH DATABASE history_handoff`.pipe(Effect.orDie),
  );
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const mainFile = databases.find((database) => database.name === "main")?.file;
  const journalFile = databases.find((database) => database.name === "history_handoff")?.file;
  const journalMode = yield* sql<{ journal_mode: string }>`PRAGMA history_handoff.journal_mode`;
  const journalSync = yield* sql<{ synchronous: number }>`PRAGMA history_handoff.synchronous`;
  if (!mainFile || !journalFile || mainFile === journalFile)
    return yield* refuse("journal-must-be-separate-disk-file", "operation");
  if (journalMode[0]?.journal_mode !== "delete" || (journalSync[0]?.synchronous ?? 0) < 2)
    return yield* refuse("unsupported-journal-mode", "operation");
  yield* sql`CREATE TABLE IF NOT EXISTS history_handoff.operation (operation_id TEXT PRIMARY KEY, frozen_at TEXT NOT NULL, source_head INTEGER NOT NULL, current_head INTEGER NOT NULL, complete INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE TABLE IF NOT EXISTS history_handoff.batches (batch_id TEXT PRIMARY KEY, command_id TEXT NOT NULL, event_hash TEXT NOT NULL, result_head INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS history_handoff.expected_state (table_name TEXT NOT NULL, entity_key TEXT NOT NULL, payload_hash TEXT NOT NULL, PRIMARY KEY (table_name, entity_key))`;

  const whereRow = (row: ProjectionRow) =>
    sql.and(
      row.table.keys.map(
        (key, index) => sql`${sql(key)} = json_extract(${row.key}, ${`$[${index}]`})`,
      ),
    );
  const readRow = (row: ProjectionRow) =>
    sql`SELECT * FROM ${sql(row.table.name)} WHERE ${whereRow(row)}`;
  const missingHash = yield* digest(encodeJson([]));
  const verifyRow = Effect.fnUntraced(function* (row: ProjectionRow, hash: string) {
    const expected = yield* sql<{
      payload_hash: string;
    }>`SELECT payload_hash FROM history_handoff.expected_state WHERE table_name = ${row.table.name} AND entity_key = ${row.key}`;
    if ((expected[0]?.payload_hash ?? missingHash) !== hash)
      return yield* refuse("projection-state-mismatch", `${row.table.name}:${row.key}`);
  });
  const checkpointRow = Effect.fnUntraced(function* (row: ProjectionRow) {
    const actual = yield* readRow(row);
    if (actual.length === 0) {
      yield* sql`DELETE FROM history_handoff.expected_state WHERE table_name = ${row.table.name} AND entity_key = ${row.key}`;
    } else {
      yield* sql`INSERT INTO history_handoff.expected_state VALUES (${row.table.name}, ${row.key}, ${yield* digest(encodeJson(actual))}) ON CONFLICT(table_name, entity_key) DO UPDATE SET payload_hash = excluded.payload_hash`;
    }
  });
  const inventory = Effect.fnUntraced(function* (initialize: boolean) {
    for (const table of Object.values(tables)) {
      let after: number | null = null;
      const entityKey = sql`json_array(${sql.csv(table.keys.map((key) => sql`${sql(key)}`))})`;
      while (true) {
        const rows: ReadonlyArray<{
          journal_row_id: number;
          journal_entity_key: string;
        }> = yield* sql<{
          journal_row_id: number;
          journal_entity_key: string;
        }>`SELECT *, rowid AS journal_row_id, ${entityKey} AS journal_entity_key FROM ${sql(table.name)} WHERE ${after === null ? sql`1` : sql`rowid > ${after}`} ORDER BY rowid LIMIT 32`;
        if (rows.length === 0) break;
        for (const { journal_row_id, journal_entity_key, ...value } of rows) {
          const hash = yield* digest(encodeJson([value]));
          if (initialize) {
            yield* sql`INSERT INTO history_handoff.expected_state VALUES (${table.name}, ${journal_entity_key}, ${hash})`;
          } else {
            yield* verifyRow({ table, key: journal_entity_key }, hash);
          }
          after = journal_row_id;
        }
      }
      if (!initialize) {
        const missing = yield* sql<{
          entity_key: string;
        }>`SELECT entity_key FROM history_handoff.expected_state expected WHERE table_name = ${table.name} AND NOT EXISTS (SELECT 1 FROM ${sql(table.name)} WHERE ${sql.and(table.keys.map((key, index) => sql`${sql(key)} = json_extract(expected.entity_key, ${`$[${index}]`})`))}) LIMIT 1`;
        if (missing[0] !== undefined)
          return yield* refuse(
            "projection-inventory-mismatch",
            `${table.name}:${missing[0].entity_key}`,
          );
      }
    }
  });
  const operations = yield* sql<{
    operation_id: string;
    frozen_at: string;
    source_head: number;
    current_head: number;
    complete: number;
  }>`SELECT * FROM history_handoff.operation`;
  const operation = operations[0];
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const currentHead = yield* store.latestApplicationSequence;
      if (operation === undefined) {
        if (currentHead !== input.expectedApplicationSequence)
          return yield* refuse("unexpected-head", "destination");
        yield* sql`INSERT INTO history_handoff.operation VALUES (${input.operationId}, ${DateTime.formatIso(input.frozenAt)}, ${input.expectedApplicationSequence}, ${currentHead}, 0)`;
        yield* inventory(true);
      } else {
        if (
          operations.length !== 1 ||
          operation.operation_id !== input.operationId ||
          operation.frozen_at !== DateTime.formatIso(input.frozenAt) ||
          operation.source_head !== input.expectedApplicationSequence ||
          operation.current_head !== currentHead
        )
          return yield* refuse("operation-or-head-mismatch", "destination");
        yield* inventory(false);
      }
    }),
  );

  const verifyHead = Effect.gen(function* () {
    const expected = yield* sql<{
      current_head: number;
    }>`SELECT current_head FROM history_handoff.operation`;
    if (expected[0]?.current_head !== (yield* store.latestApplicationSequence))
      return yield* refuse("unexpected-head", "destination");
  });

  const verifyThreadBatch = Effect.fnUntraced(function* (
    events: readonly OrchestrationV2DomainEvent[],
  ) {
    yield* verifyHead;
    const affected = new Map<string, ProjectionRow>();
    const add = (table: ProjectionTable, ...ids: readonly string[]) => {
      const key = encodeJson(ids);
      affected.set(`${table.name}:${key}`, { table, key });
    };
    for (const event of events) {
      add(tables.threads, event.threadId);
      switch (event.type) {
        case "thread.metadata-updated":
          break;
        case "run.updated":
          add(tables.runs, event.payload.id);
          break;
        case "run-attempt.updated":
          add(tables.attempts, event.payload.id);
          break;
        case "node.updated":
          add(tables.nodes, event.payload.id);
          break;
        case "subagent.updated":
          add(tables.subagents, event.payload.id);
          break;
        case "provider-session.updated":
          add(tables.sessions, event.payload.id);
          break;
        case "provider-session.detached":
          add(tables.bindings, event.payload.providerSessionId, event.threadId);
          break;
        case "provider-thread.updated":
          add(tables.providerThreads, event.payload.id);
          if (event.payload.appThreadId !== null) add(tables.threads, event.payload.appThreadId);
          break;
        case "provider-turn.updated":
          add(tables.turns, event.payload.id);
          break;
        case "runtime-request.updated":
          add(tables.requests, event.payload.id);
          break;
        case "message.updated":
          add(tables.messages, event.payload.id);
          break;
        case "turn-item.updated":
          add(tables.items, event.payload.id);
          add(tables.positions, event.threadId, event.payload.id);
          break;
        case "context-handoff.updated":
          add(tables.handoffs, event.payload.id);
          break;
        case "context-transfer.created":
        case "context-transfer.updated":
          add(tables.transfers, event.payload.id);
          break;
        default:
          return yield* refuse("unsupported-freeze-event", event.type);
      }
    }
    for (const row of affected.values())
      yield* verifyRow(row, yield* digest(encodeJson(yield* readRow(row))));
    return { checkpoint: Effect.forEach(affected.values(), checkpointRow, { discard: true }) };
  });
  const verifyProject = Effect.fnUntraced(function* (id: ProjectId) {
    yield* verifyHead;
    const row = { table: tables.projects, key: encodeJson([id]) };
    yield* verifyRow(row, yield* digest(encodeJson(yield* readRow(row))));
    return { checkpoint: checkpointRow(row) };
  });
  const finish = sql.withTransaction(
    Effect.gen(function* () {
      yield* verifyHead;
      yield* inventory(false);
      yield* sql`UPDATE history_handoff.operation SET complete = 1`;
    }),
  );
  return { alreadyFrozen: operation?.complete === 1, verifyThreadBatch, verifyProject, finish };
});
