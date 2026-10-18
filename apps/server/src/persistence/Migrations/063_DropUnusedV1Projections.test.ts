import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("063_DropUnusedV1Projections", (it) => {
  it.effect(
    "retains all six legacy tables and their exact values when upgrading and rerunning",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 62 });
        const reasoning = ' { "summary": "Original é ☃", "null": null, "escaped": "\\u0000" } ';
        yield* sql`ALTER TABLE projection_turns ADD COLUMN reasoning_json TEXT`;
        yield* sql`
        INSERT INTO projection_thread_messages
          (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
        VALUES ('message-1', 'thread-1', 'user', 'hello', 0, '2026-01-01', '2026-01-01')
      `;
        yield* sql`
        INSERT INTO projection_thread_activities
          (activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence)
        VALUES ('activity-1', 'thread-1', 'turn-1', 'info', 'legacy', 'Retained é ☃', '{ "value": null }', '2026-01-01', 7)
      `;
        yield* sql`
        INSERT INTO projection_turns
          (row_id, thread_id, turn_id, state, requested_at, checkpoint_turn_count, checkpoint_files_json, reasoning_json)
        VALUES (7, 'thread-1', 'turn-1', 'completed', '2026-01-01', 1, '[ "file.swift" ]', ${reasoning})
      `;
        yield* sql`
        INSERT INTO projection_thread_proposed_plans
          (plan_id, thread_id, turn_id, plan_markdown, created_at, updated_at, implemented_at, implementation_thread_id)
        VALUES ('plan-1', 'thread-1', 'turn-1', '# Original é ☃', '2026-01-01', '2026-01-02', NULL, NULL)
      `;
        yield* sql`
        INSERT INTO projection_pending_approvals
          (request_id, thread_id, turn_id, status, decision, created_at, resolved_at)
        VALUES ('request-1', 'thread-1', 'turn-1', 'pending', NULL, '2026-01-01', NULL)
      `;
        yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES ('legacy-projector', 9007199254740991, '2026-01-01')
      `;
        yield* sql`
        INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at)
        VALUES ('thread-1', 0, 1, X'00FF8041', '2026-01-01')
      `;
        const snapshot = Effect.gen(function* () {
          const tables = [
            "projection_thread_activities",
            "projection_turns",
            "projection_thread_proposed_plans",
            "projection_pending_approvals",
            "projection_state",
            "checkpoint_diff_blobs",
          ];
          return yield* Effect.forEach(tables, (table) =>
            Effect.gen(function* () {
              const columns = yield* sql.unsafe<{ readonly name: string }>(
                `PRAGMA table_info("${table}")`,
              );
              assert.isAbove(columns.length, 0, table);
              return {
                table,
                rows: yield* sql.unsafe(`SELECT * FROM "${table}" ORDER BY rowid`),
                storageClasses: yield* sql.unsafe(
                  `SELECT ${columns.map(({ name }) => `typeof("${name}") AS "${name}"`).join(", ")} FROM "${table}" ORDER BY rowid`,
                ),
              };
            }),
          );
        });
        const before = yield* snapshot;
        for (const table of before) assert.lengthOf(table.rows, 1, table.table);
        assert.deepEqual(yield* sql`SELECT reasoning_json FROM projection_turns`, [
          { reasoning_json: reasoning },
        ]);
        assert.deepEqual(
          yield* sql`SELECT hex(diff) AS bytes, typeof(diff) AS storage_class FROM checkpoint_diff_blobs`,
          [{ bytes: "00FF8041", storage_class: "blob" }],
        );

        for (let pass = 0; pass < 2; pass++) {
          const migrations = yield* runMigrations({ toMigrationInclusive: 63 });
          assert.deepEqual(migrations, pass === 0 ? [[63, "DropUnusedV1Projections"]] : []);
          assert.deepEqual(yield* snapshot, before);
          assert.deepEqual(
            yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id = 63`,
            [{ migration_id: 63, name: "DropUnusedV1Projections" }],
          );
          assert.deepEqual(yield* sql`SELECT message_id FROM projection_thread_messages`, [
            { message_id: "message-1" },
          ]);
        }
      }),
  );
});
