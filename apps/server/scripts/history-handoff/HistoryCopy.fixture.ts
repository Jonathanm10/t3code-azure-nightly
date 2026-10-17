// @effect-diagnostics nodeBuiltinImport:off - The fixture owns disk-backed SQLite WAL state and synthetic attachment files.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ChatAttachmentId, CommandId, EventId, MessageId, TurnItemId } from "@t3tools/contracts";
import { runMigrations } from "../../src/persistence/Migrations.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import { historyLayer, hydrateLegacyHistory } from "./HistoryFreeze.ts";
import { seed, now } from "./HistoryFreeze.fixture.ts";

export const excludedStoreNames = [
  "auth_pairing_links",
  "auth_sessions",
  "orchestration_command_receipts",
  "orchestration_v2_command_receipts",
  "orchestration_v2_effect_outbox",
  "orchestration_v2_thread_launch_workflows",
  "projection_pending_approvals",
  "provider_session_runtime",
  "scheduled_tasks",
  "scheduled_task_webhook_deliveries",
  "scheduled_task_webhook_relay_deliveries",
] as const;
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
  "base64",
);
export const fixture = Effect.fnUntraced(function* () {
  const root = yield* Effect.acquireRelease(
    Effect.promise(async () =>
      NodeFSP.realpath(await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-copy-"))),
    ),
    (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
  );
  yield* Effect.promise(() =>
    NodeFSP.writeFile(NodePath.join(root, ".history-synthetic-fixture"), "synthetic", {
      mode: 0o600,
    }),
  );
  const sourceState = NodePath.join(root, "source");
  yield* Effect.promise(() => NodeFSP.mkdir(sourceState));
  const filename = NodePath.join(sourceState, "statev2.sqlite");
  const sqlLayer = NodeSqliteClient.layer({ filename });
  yield* runMigrations().pipe(Effect.provide(sqlLayer));
  const originalText = `Original é ☃ ![screenshot](${sourceState}/browser-artifacts/shot.png)`;
  yield* Effect.gen(function* () {
    const { parent } = yield* seed();
    const sql = yield* SqlClient.SqlClient;
    yield* sql`ALTER TABLE projection_turns ADD COLUMN reasoning_json TEXT`;
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.commitCommand({
      commandId: CommandId.make("screenshot"),
      threadId: parent.id,
      commandType: "fixture",
      acceptedAt: now,
      effects: [],
      events: [
        {
          id: EventId.make("screenshot"),
          type: "message.updated",
          threadId: parent.id,
          occurredAt: now,
          payload: {
            id: MessageId.make("screenshot"),
            threadId: parent.id,
            runId: null,
            nodeId: null,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: originalText,
            attachments: [
              {
                type: "image",
                id: ChatAttachmentId.make("parent-11111111-1111-4111-8111-111111111111-png"),
                name: "attached.png",
                mimeType: "image/png",
                sizeBytes: png.length,
              },
            ],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const tools = [
      {
        id: "browser-tool",
        toolName: "mcp__t3-code__browser_snapshot",
        output: {
          content: [
            {
              type: "text",
              text: `{  "screenshotPath" : "${sourceState}/browser-artifacts/shot.png", "keep":"é" }`,
            },
          ],
        },
      },
      {
        id: "html-tool",
        toolName: "mcp__t3-code__html_render",
        output: {
          htmlRender: {
            attachmentId: "parent-22222222-2222-4222-8222-222222222222-html",
            title: "Saved HTML",
            height: 300,
          },
        },
      },
      {
        id: "mcp-tool",
        toolName: "fixture.viewer",
        output: {
          t3McpApp: {
            attachmentId: "parent-33333333-3333-4333-8333-333333333333-html",
            server: "fixture",
            tool: "viewer",
            resourceUri: "ui://fixture/view",
          },
        },
      },
    ];
    for (const tool of tools)
      yield* sink.commitCommand({
        commandId: CommandId.make(tool.id),
        threadId: parent.id,
        commandType: "fixture",
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: EventId.make(tool.id),
            type: "turn-item.updated",
            threadId: parent.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(tool.id),
              threadId: parent.id,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "completed",
              type: "dynamic_tool",
              title: tool.id,
              toolName: tool.toolName,
              input: {},
              output: tool.output,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    for (const id of ["legacy-complete", "legacy-pending"]) {
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,archived_at) VALUES (${id},'project:synthetic','Legacy','{"instanceId":"codex","model":"synthetic"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES (${`${id}:message`},${id},'assistant',${`Retained ${id}`},'[]',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_turns (thread_id,turn_id,state,requested_at,checkpoint_files_json,reasoning_json) VALUES (${id},${`${id}:turn`},'completed','2026-01-01T00:00:00.000Z','[]',' { "summary": "Legacy é ☃", "null": null } ')`;
      if (id === "legacy-complete") yield* hydrateLegacyHistory();
    }
  }).pipe(Effect.provide(historyLayer.pipe(Layer.provideMerge(sqlLayer))));
  const database = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeSqlite.DatabaseSync(filename)),
    (db) => Effect.sync(() => db.close()),
  );
  database.exec("PRAGMA journal_mode=WAL");
  const authIndexes = database
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='auth_sessions' AND sql IS NOT NULL",
    )
    .all();
  database.exec("DROP TABLE auth_sessions");
  database.exec(
    "CREATE TABLE auth_sessions (\n      session_id TEXT PRIMARY KEY,\n      subject TEXT NOT NULL,\n      scopes TEXT NOT NULL,\n      method TEXT NOT NULL,\n      client_label TEXT,\n      client_ip_address TEXT,\n      client_user_agent TEXT,\n      client_device_type TEXT NOT NULL DEFAULT 'unknown',\n      client_os TEXT,\n      client_browser TEXT,\n      issued_at TEXT NOT NULL,\n      expires_at TEXT NOT NULL,\n      last_connected_at TEXT,\n      revoked_at TEXT\n    )",
  );
  for (const index of authIndexes) if (typeof index.sql === "string") database.exec(index.sql);
  database.exec(
    "UPDATE effect_sql_migrations SET name='ProjectionTurnsReasoning' WHERE migration_id=41",
  );
  for (const name of excludedStoreNames) {
    const table = { name };
    database.exec(`DELETE FROM "${table.name}"`);
    const columns = database.prepare(`PRAGMA table_info("${table.name}")`).all();
    const names = columns.map((column) => String(column.name));
    const values = columns.map((column) =>
      column.name === "status"
        ? "pending"
        : String(column.type).includes("INT")
          ? 1
          : `excluded:${table.name}:${column.name}`,
    );
    database
      .prepare(
        `INSERT INTO "${table.name}" (${names.map((name) => `"${name}"`).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
      )
      .run(...values);
  }
  database.exec(
    "INSERT INTO orchestration_v2_events (sequence,event_id,command_id,thread_id,run_id,node_id,provider,raw_event_id,event_type,occurred_at,payload_json,driver,provider_instance_id) VALUES (9999,'retained-old-event','retained-old-command','legacy-complete',NULL,NULL,'codex',NULL,'historical.retained','2026-01-01T00:00:00.000Z','{}','codex','synthetic-codex')",
  );
  database
    .prepare("INSERT INTO checkpoint_diff_blobs VALUES (?, ?, ?, ?, ?)")
    .run("parent", 0, 1, Buffer.from([0, 255, 128, 65]), "2026-01-01T00:00:00.000Z");
  database
    .prepare("INSERT INTO mcp_app_model_context VALUES (?, ?, ?, ?, ?, ?)")
    .run(
      "parent",
      "item",
      "synthetic",
      "fixture",
      "Unicode é ☃ and null",
      "2026-01-01T00:00:00.000Z",
    );
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(sourceState, "browser-artifacts"));
    await NodeFSP.writeFile(NodePath.join(sourceState, "browser-artifacts", "shot.png"), png);
    await NodeFSP.mkdir(NodePath.join(sourceState, "attachments"));
    await NodeFSP.writeFile(
      NodePath.join(
        sourceState,
        "attachments",
        "parent-11111111-1111-4111-8111-111111111111-png.png",
      ),
      png,
    );
    for (const id of [
      "parent-22222222-2222-4222-8222-222222222222-html",
      "parent-33333333-3333-4333-8333-333333333333-html",
    ])
      await NodeFSP.writeFile(
        NodePath.join(sourceState, "attachments", `${id}.html`),
        "<!doctype html><p>Saved é ☃</p>",
      );
    await NodeFSP.writeFile(
      NodePath.join(sourceState, "settings.json"),
      '{"defaultAutoPull":true,"secret":"source-settings"}',
    );
    await NodeFSP.mkdir(NodePath.join(sourceState, "secrets"));
    await NodeFSP.writeFile(NodePath.join(sourceState, "secrets", "sentinel"), "source-secret");
    await NodeFSP.writeFile(NodePath.join(sourceState, "cookie-store"), "source-cookie");
  });
  return {
    root,
    sourceState,
    filename,
    database,
    originalText,
    targetHome: NodePath.join(root, "target"),
    operationDirectory: NodePath.join(root, "operation"),
  };
});
