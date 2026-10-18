// @effect-diagnostics nodeBuiltinImport:off - Tests own native SQLite and temporary files to verify refusal before copying.
import * as NodeSqlite from "node:sqlite";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { it, expect } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as Legacy from "../../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { layerFixture, freeze, frozenAt } from "./HistoryFreeze.fixture.ts";
import { hydrateLegacyHistory } from "./HistoryFreeze.ts";
import { runMigrations } from "../../src/persistence/Migrations.ts";
import {
  assertSourceHistorySchema,
  assertDestinationHistorySchema,
} from "./HistoryCapturePolicy.ts";

it.effect.each([62, 63] as const)(
  "admits paired source profiles at migration %s and rejects schema or ledger drift",
  (lastMigration) =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-capture-policy-"))),
        (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      );
      const filename = NodePath.join(root, "statev2.sqlite");
      yield* runMigrations({ toMigrationInclusive: lastMigration }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename })),
      );
      yield* Effect.sync(() => {
        const db = new NodeSqlite.DatabaseSync(filename);
        try {
          expect(() => assertSourceHistorySchema(db)).toThrow(
            "table-definition-mismatch (projection_turns)",
          );
          db.exec("ALTER TABLE projection_turns ADD COLUMN reasoning_json TEXT");
          const currentPolicyDigest = assertSourceHistorySchema(db);
          expect(currentPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
          if (lastMigration === 63)
            expect(assertDestinationHistorySchema(db)).toBe(currentPolicyDigest);
          else
            expect(() => assertDestinationHistorySchema(db)).toThrow("migration-ledger-mismatch");
          db.exec(
            "UPDATE effect_sql_migrations SET name='ProjectionTurnsReasoning' WHERE migration_id=41",
          );
          expect(() => assertSourceHistorySchema(db)).toThrow("migration-ledger-mismatch");
          expect(() => assertDestinationHistorySchema(db)).toThrow("migration-ledger-mismatch");
          db.exec(
            "UPDATE effect_sql_migrations SET name='AuthSessionClientConnection' WHERE migration_id=41",
          );
          db.exec("DROP TABLE auth_sessions");
          db.exec(
            "CREATE TABLE auth_sessions (\n      session_id TEXT PRIMARY KEY,\n      subject TEXT NOT NULL,\n      scopes TEXT NOT NULL,\n      method TEXT NOT NULL,\n      client_label TEXT,\n      client_ip_address TEXT,\n      client_user_agent TEXT,\n      client_device_type TEXT NOT NULL DEFAULT 'unknown',\n      client_os TEXT,\n      client_browser TEXT,\n      issued_at TEXT NOT NULL,\n      expires_at TEXT NOT NULL,\n      last_connected_at TEXT,\n      revoked_at TEXT\n    )",
          );
          expect(() => assertDestinationHistorySchema(db)).toThrow(
            "destination-auth-schema-mismatch",
          );
          db.exec("DROP TABLE projection_turns");
          db.exec(
            "CREATE TABLE projection_turns (\n      row_id INTEGER PRIMARY KEY AUTOINCREMENT,\n      thread_id TEXT NOT NULL,\n      turn_id TEXT,\n      pending_message_id TEXT,\n      assistant_message_id TEXT,\n      state TEXT NOT NULL,\n      requested_at TEXT NOT NULL,\n      started_at TEXT,\n      completed_at TEXT,\n      checkpoint_turn_count INTEGER,\n      checkpoint_ref TEXT,\n      checkpoint_status TEXT,\n      checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT, reasoning_json TEXT,\n      UNIQUE (thread_id, turn_id),\n      UNIQUE (thread_id, checkpoint_turn_count)\n    )",
          );
          expect(() => assertSourceHistorySchema(db)).toThrow("migration-ledger-mismatch");
          db.exec(
            "UPDATE effect_sql_migrations SET name='ProjectionTurnsReasoning' WHERE migration_id=41",
          );
          expect(assertSourceHistorySchema(db)).toBe(currentPolicyDigest);
          db.exec("CREATE TABLE unreviewed_secret (value TEXT)");
          expect(() => assertSourceHistorySchema(db)).toThrow("table-inventory-mismatch");
          db.exec("DROP TABLE unreviewed_secret");
          db.exec("ALTER TABLE projection_projects ADD COLUMN unreviewed_secret TEXT");
          expect(() => assertSourceHistorySchema(db)).toThrow("table-definition-mismatch");
          db.exec("ALTER TABLE projection_projects DROP COLUMN unreviewed_secret");
          db.exec("CREATE UNIQUE INDEX unexpected_unique ON projection_projects(title)");
          expect(() => assertSourceHistorySchema(db)).toThrow("unique-index-mismatch");
          db.exec("DROP INDEX unexpected_unique");
          db.exec("CREATE VIEW unexpected_view AS SELECT title FROM projection_projects");
          expect(() => assertSourceHistorySchema(db)).toThrow("unexpected-trigger-or-view");
          db.exec("DROP VIEW unexpected_view");
          db.exec(
            "CREATE TRIGGER unexpected_trigger AFTER INSERT ON projection_projects BEGIN SELECT 1; END",
          );
          expect(() => assertSourceHistorySchema(db)).toThrow("unexpected-trigger-or-view");
          db.exec("DROP TRIGGER unexpected_trigger");
          db.exec("PRAGMA user_version=1");
          expect(() => assertSourceHistorySchema(db)).toThrow("user-version-mismatch");
          db.exec("PRAGMA user_version=0");
          db.exec(
            "INSERT INTO effect_sql_migrations (migration_id,name) VALUES (64,'UnreviewedMigration')",
          );
          expect(() => assertSourceHistorySchema(db)).toThrow("migration-ledger-mismatch");
          db.exec("DELETE FROM effect_sql_migrations WHERE migration_id=64");
          db.exec(
            `UPDATE effect_sql_migrations SET name = 'wrong' WHERE migration_id = ${lastMigration}`,
          );
          expect(() => assertSourceHistorySchema(db)).toThrow("migration-ledger-mismatch");
          db.exec("DROP TABLE projection_turns");
          expect(() => assertSourceHistorySchema(db)).toThrow("table-inventory-mismatch");
        } finally {
          db.close();
        }
      });
    }),
);

it.effect(
  "preserves legacy reasoning bytes through current migrations, hydration, freeze and two rebuilds",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const importer = yield* Legacy.LegacyV1ThreadImporter;
      const store = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const id = ThreadId.make("legacy-reasoning");
      const reasoning = ' { "summary": "Original é ☃", "null": null, "escaped": "\\u0000" } ';
      yield* sql`ALTER TABLE projection_turns ADD COLUMN reasoning_json TEXT`;
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('legacy-project','Legacy','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,archived_at) VALUES (${id},'legacy-project','Legacy discussion','{"instanceId":"codex","model":"synthetic"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('legacy-message',${id},'assistant','Original legacy partial answer','[]',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
      yield* sql`INSERT INTO projection_turns (row_id,thread_id,turn_id,state,requested_at,checkpoint_files_json,reasoning_json) VALUES (7,${id},'legacy-turn','completed','2026-01-01T00:00:00.000Z','[]',${reasoning})`;
      const before = yield* sql`SELECT * FROM projection_turns`;
      expect(yield* importer.pendingThreadCount).toBe(1);
      yield* runMigrations();
      expect(yield* sql`SELECT * FROM projection_turns`).toEqual(before);
      yield* hydrateLegacyHistory();
      expect(yield* importer.pendingThreadCount).toBe(0);
      expect((yield* projections.getThreadProjection(id)).messages[0]?.text).toBe(
        "Original legacy partial answer",
      );
      yield* freeze({
        operationId: "legacy-reasoning",
        frozenAt,
        expectedApplicationSequence: yield* store.latestApplicationSequence,
      });
      const frozen = yield* projections.getThreadProjection(id);
      for (let pass = 0; pass < 2; pass++) {
        expect((yield* maintenance.rebuild).valid).toBe(true);
        yield* hydrateLegacyHistory();
        expect(yield* projections.getThreadProjection(id)).toEqual(frozen);
        expect(yield* sql`SELECT * FROM projection_turns`).toEqual(before);
      }
    }).pipe(Effect.provide(layerFixture)),
);
