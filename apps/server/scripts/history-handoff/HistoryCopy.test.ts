// @effect-diagnostics nodeBuiltinImport:off - These tests own real SQLite WAL connections and disposable filesystem packages.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { it, expect, vi } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  StoredProjectIcon,
} from "@t3tools/contracts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import { historyLayer } from "./HistoryFreeze.ts";
import { now } from "./HistoryFreeze.fixture.ts";
import { copyHistory } from "./HistoryCopy.ts";
import { assertDestinationHistorySchema } from "./HistoryCapturePolicy.ts";
import { HistoryCaptureRefused, openCaptureJournal, tableDigest } from "./HistoryCapture.ts";
import { resolveMediaSource } from "../../../../packages/client-runtime/src/mediaSource.ts";
import {
  markdownAssetReferences,
  rewriteMarkdownAssets,
  historyReferences,
  relocateHistoryValue,
} from "./HistoryReferences.ts";

import { excludedStoreNames, fixture, png } from "./HistoryCopy.fixture.ts";

function startJournalReader(filename: string) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { DatabaseSync } from "node:sqlite";
       const db = new DatabaseSync(process.argv[1], { readOnly: true });
       db.exec("BEGIN; SELECT * FROM external_dependencies");
       process.stdout.write("LOCKED\\n");
       process.stdin.once("data", () => setTimeout(() => {
         db.exec("ROLLBACK");
         db.close();
         process.stdin.destroy();
       }, 100));`,
      filename,
    ],
    { detached: true, stdio: ["pipe", "pipe", "pipe"], timeout: 10_000, killSignal: "SIGKILL" },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("No captured reader PID");
  process.stdout.write(`Captured journal reader PID/PGID ${pid}/${pid} at launch.\n`);
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const ready = new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout.on("data", (bytes) => {
      output += String(bytes);
      if (output.includes("LOCKED\n")) resolve();
    });
    child.once("error", reject);
    child.once("close", () => reject(new Error("Journal reader exited before release")));
  });
  return {
    ready,
    exit,
    release: () => child.stdin.end("release\n"),
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
      expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      process.stdout.write(
        `Captured journal reader PID/PGID ${pid}/${pid} exited; group absent.\n`,
      );
    },
  };
}

it.effect.each(["brief", "persistent"] as const)(
  "handles a %s shared reader with the native capture journal busy timeout",
  (duration) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const filename = NodePath.join(f.root, "contention.sqlite");
      const journal = yield* Effect.acquireRelease(
        Effect.sync(() => openCaptureJournal(filename)),
        (db) => Effect.sync(() => db.close()),
      );
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => startJournalReader(filename)),
        (child) => Effect.promise(() => child.stop()),
      );
      yield* Effect.promise(() => reader.ready);
      const insert =
        "INSERT INTO external_dependencies VALUES ('project', 'ref', 'resolved', 'present')";
      const immediate = new NodeSqlite.DatabaseSync(filename);
      try {
        expect(() => immediate.exec(insert)).toThrow(
          expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }),
        );
      } finally {
        immediate.close();
      }
      if (duration === "persistent") {
        journal.exec("PRAGMA busy_timeout=25");
        expect(() => journal.exec(insert)).toThrow(
          expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 5 }),
        );
        expect(journal.prepare("SELECT * FROM external_dependencies").all()).toEqual([]);
        reader.release();
      } else {
        reader.release();
        journal.exec(insert);
        expect(journal.prepare("SELECT project_id FROM external_dependencies").all()).toEqual([
          { project_id: "project" },
        ]);
      }
      expect(yield* Effect.promise(() => reader.exit)).toEqual({ code: 0, signal: null });
    }),
);

it.effect.each([
  { name: "Error", code: "ERR_SQLITE_ERROR", errcode: 5 },
  { name: "Error", code: "ENOSPC", errno: -28 },
  { name: "Error", code: "PRIVATE_DIAGNOSTIC_SECRET", errno: -28 },
  { name: "PRIVATE_DIAGNOSTIC_SECRET", code: "EACCES", errno: -13 },
  { name: "Error", code: "EIO", errno: Number.POSITIVE_INFINITY },
  { name: "Error", code: "EIO", errno: 1.5 },
  { name: "Error", code: "EIO", errno: Number.MAX_SAFE_INTEGER + 1 },
  { name: "Error", code: "EIO", errno: 2_147_483_648 },
  { name: "Error", code: "EIO", errno: -5, wrappers: 4 },
])("persists only safe error diagnostics for $name/$code/$errno/$errcode", (fields) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const secret = "PRIVATE_DIAGNOSTIC_SECRET";
    const failure = Object.assign(new Error(secret), fields, {
      stack: secret,
      path: secret,
      syscall: secret,
      sql: secret,
      nested: { secret },
    });
    const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(NodeSqlite.DatabaseSync.prototype, "prepare").mockImplementation(function (
          this: NodeSqlite.DatabaseSync,
          sql,
        ) {
          if (sql === "INSERT INTO asset_candidates VALUES (?, ?, ?, ?)") {
            let cause: unknown = failure;
            for (let depth = 0; depth < (fields.wrappers ?? 2); depth++)
              cause = new HistoryCaptureRefused({ reason: "io-failure", cause });
            throw cause;
          }
          return prepare.call(this, sql);
        }),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const result = yield* copyHistory(f);
    expect(result).toEqual({
      kind: "refused",
      reason: "io-failure",
      receiptPath: NodePath.join(f.operationDirectory, "refusal.json"),
    });
    const receipt = yield* Effect.promise(() =>
      NodeFSP.readFile(NodePath.join(f.operationDirectory, "refusal.json"), "utf8"),
    );
    expect(receipt).not.toContain(secret);
    const expected =
      fields.code === "ERR_SQLITE_ERROR" || fields.code === "ENOSPC" ? { diagnostic: fields } : {};
    expect(JSON.parse(receipt)).toEqual({
      version: 1,
      operationId: expect.any(String),
      reason: "io-failure",
      ...expected,
    });
    expect(
      (yield* Effect.promise(() =>
        NodeFSP.stat(NodePath.join(f.operationDirectory, "refusal.json")),
      )).mode & 0o777,
    ).toBe(0o600);
    expect(
      yield* Effect.promise(() =>
        NodeFSP.access(f.targetHome).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false);
  }),
);

it("distinguishes real Markdown destinations, code literals, escaped links, file URIs and structured tool output", () => {
  const source = "/source/browser-artifacts/shot.png";
  const destination = "/target/userdata/browser-artifacts/shot.png";
  const text = `![real](${source})\n\`![literal](${source})\`\n\n\`\`\`markdown\n![code](${source})\n\`\`\`\n!\\[escaped](${source})\n\n![uri](file://${source})\nplain ${source}`;
  expect(markdownAssetReferences(text).map((reference) => reference.value)).toEqual([
    source,
    `file://${source}`,
  ]);
  const result = rewriteMarkdownAssets(text, (path) => (path === source ? destination : undefined));
  expect(result.changes).toHaveLength(2);
  expect(result.text).toContain(`\`![literal](${source})\``);
  expect(result.text).toContain(`![code](${source})`);
  expect(result.text).toContain(`!\\[escaped](${source})`);
  expect(result.text).toContain(`plain ${source}`);
  for (const html of [
    `<img src="${source}">`,
    `<IMG SRC="${source}">`,
    `[<IMG SRC="${source}">](${source})`,
    `<img src="${source.replaceAll("/", "&#47;")}">`,
  ]) {
    expect(markdownAssetReferences(html)).toContainEqual({ kind: "unsupported", value: source });
    expect(() =>
      rewriteMarkdownAssets(html, (path) => (path === source ? destination : undefined)),
    ).toThrow("unsupported-renderable-reference");
  }
  expect(markdownAssetReferences(`<img src=${source}>`)).toEqual([]);
  expect(markdownAssetReferences(`\`<IMG SRC="${source}">\``)).toEqual([]);
  expect(markdownAssetReferences(`\`\`\`html\n<IMG SRC="${source}">\n\`\`\``)).toEqual([]);
  expect(
    rewriteMarkdownAssets(`![reference][shot]\n\n[shot]: ${source}`, (path) =>
      path === source ? destination : undefined,
    ).text,
  ).toBe(`![reference][shot]\n\n[shot]: ${destination}`);
  const message = {
    role: "assistant",
    text: `![real](${source})`,
    attachments: [],
    context: { text: `![context metadata](/source/browser-artifacts/input-only.png)` },
  };
  expect(historyReferences(message).paths).toEqual([source]);
  expect(
    relocateHistoryValue(message, (path) => (path === source ? destination : undefined)).value,
  ).toEqual({ ...message, text: `![real](${destination})` });
  const tool = {
    type: "dynamic_tool",
    input: { text: "![literal input](/source/browser-artifacts/input-only.png)" },
    output: { screenshotPath: source },
  };
  expect(historyReferences(tool, true).paths).toEqual([source]);
  expect(
    relocateHistoryValue(tool, (path) => (path === source ? destination : undefined), true).value,
  ).toEqual({ ...tool, output: { screenshotPath: destination } });
  const output = {
    content: [{ type: "text", text: `{  "screenshotPath" : "${source}", "keep":"exact" }` }],
  };
  expect(historyReferences(output, true).paths).toEqual([source]);
  expect(
    relocateHistoryValue(output, (path) => (path === source ? destination : undefined), true).value,
  ).toEqual({
    content: [{ type: "text", text: `{  "screenshotPath" : "${destination}", "keep":"exact" }` }],
  });
});

it.effect.each([
  { authLayout: "legacy", lastMigration: 62 },
  { authLayout: "legacy", lastMigration: 63 },
  { authLayout: "current", lastMigration: 62 },
  { authLayout: "current", lastMigration: 63 },
] as const)(
  "copies $authLayout history at migration $lastMigration, excludes operational state and rejects installed divergence",
  (sourceProfile) =>
    Effect.gen(function* () {
      const f = yield* fixture(sourceProfile);
      const before = tableDigest(f.database, "orchestration_events");
      const sourceHash = (path: string) =>
        NodeFSP.readFile(path).then((bytes) =>
          NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        );
      const mainBefore = yield* Effect.promise(() => sourceHash(f.filename));
      const walBefore = yield* Effect.promise(() => sourceHash(`${f.filename}-wal`));
      const result = yield* copyHistory(f);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const target = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
      );
      try {
        expect(
          tableDigest(target, "orchestration_events", {
            through: result.receipt.cut.applicationSequence,
          }),
        ).toEqual(before);
        for (const name of excludedStoreNames.filter((name) => !name.includes("command_receipts")))
          expect(target.prepare(`SELECT count(*) AS count FROM "${name}"`).get()?.count).toBe(0);
        expect(
          target
            .prepare(
              "SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_id LIKE 'excluded:%'",
            )
            .get()?.count,
        ).toBe(0);
        expect(
          target
            .prepare(
              "SELECT count(*) AS count FROM orchestration_v2_command_receipts WHERE command_id LIKE 'excluded:%'",
            )
            .get()?.count,
        ).toBe(0);
        expect(
          f.database.prepare("SELECT name FROM effect_sql_migrations WHERE migration_id=41").get()
            ?.name,
        ).toBe(
          sourceProfile.authLayout === "legacy"
            ? "ProjectionTurnsReasoning"
            : "AuthSessionClientConnection",
        );
        expect(
          target.prepare("SELECT name FROM effect_sql_migrations WHERE migration_id=41").get()
            ?.name,
        ).toBe("AuthSessionClientConnection");
        expect(
          f.database.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
        ).toBe(sourceProfile.lastMigration);
        expect(
          target.prepare("SELECT MAX(migration_id) AS id FROM effect_sql_migrations").get()?.id,
        ).toBe(63);
        expect(assertDestinationHistorySchema(target)).toBe(result.receipt.cut.policyDigest);
        expect(result.receipt.cut.agentSequence).toBeLessThan(9999);
        expect(tableDigest(target, "orchestration_v2_events")).toEqual(
          tableDigest(f.database, "orchestration_v2_events"),
        );
        for (const name of [
          "checkpoint_diff_blobs",
          "projection_turns",
          "projection_thread_activities",
          "projection_thread_proposed_plans",
        ]) {
          expect(tableDigest(target, name)).toEqual(tableDigest(f.database, name));
        }
        expect(target.prepare("SELECT count(*) AS count FROM projection_state").get()?.count).toBe(
          0,
        );
        expect(tableDigest(target, "mcp_app_model_context")).toEqual(
          tableDigest(f.database, "mcp_app_model_context"),
        );
        expect(
          target
            .prepare(
              "SELECT count(*) AS count FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NULL OR last_error IS NOT NULL",
            )
            .get()?.count,
        ).toBe(0);
        expect(
          target
            .prepare(
              "SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_messages WHERE message_id='legacy-pending:message'",
            )
            .get()?.text,
        ).toBe("Retained legacy-pending");
        const text = target
          .prepare(
            "SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_messages WHERE message_id='screenshot'",
          )
          .get()?.text;
        expect(text).toBe(
          f.originalText.replace(f.sourceState, NodePath.join(f.targetHome, "userdata")),
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(f.targetHome, "userdata", "browser-artifacts", "shot.png"),
            ),
          ),
        ).toEqual(png);
        const paths = yield* Effect.promise(() =>
          NodeFSP.readdir(NodePath.join(f.targetHome, "userdata")),
        );
        expect(
          yield* Effect.promise(() =>
            NodeFSP.readdir(NodePath.join(f.targetHome, "userdata", "attachments")),
          ),
        ).toHaveLength(3);
        const toolOutput = target
          .prepare(
            "SELECT json_extract(payload_json,'$.output.content[0].text') AS text FROM orchestration_v2_projection_turn_items WHERE turn_item_id='browser-tool'",
          )
          .get()?.text;
        expect(toolOutput).toBe(
          `{  "screenshotPath" : "${f.targetHome}/userdata/browser-artifacts/shot.png", "keep":"é" }`,
        );
        expect(
          target
            .prepare(
              "SELECT count(*) AS count FROM orchestration_v2_projection_provider_session_bindings",
            )
            .get()?.count,
        ).toBe(0);
        expect(paths).not.toContain("settings.json");
        expect(paths).not.toContain("secrets");
        expect(paths).not.toContain("cookie-store");
      } finally {
        target.close();
      }
      expect(yield* copyHistory(f)).toMatchObject({ kind: "already-installed" });
      expect(yield* Effect.promise(() => sourceHash(f.filename))).toBe(mainBefore);
      expect(yield* Effect.promise(() => sourceHash(`${f.filename}-wal`))).toBe(walBefore);
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(f.targetHome, "userdata", "settings.json"), "{}"),
      );
      expect(yield* copyHistory(f)).toMatchObject({
        kind: "refused",
        reason: "destination-diverged",
      });
    }),
);

it.effect(
  "refuses an existing opted-in destination and missing required content without replacing anything",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(f.targetHome, "userdata"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(f.targetHome, "userdata", "settings.json"),
          '{"defaultAutoPull":true}',
        );
      });
      expect(yield* copyHistory(f)).toMatchObject({
        kind: "refused",
        reason: "target-already-exists",
      });
      expect(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.targetHome, "userdata", "settings.json"), "utf8"),
        ),
      ).toBe('{"defaultAutoPull":true}');
      yield* Effect.promise(() =>
        NodeFSP.unlink(NodePath.join(f.sourceState, "browser-artifacts", "shot.png")),
      );
      const refused = yield* copyHistory({
        ...f,
        targetHome: NodePath.join(f.root, "other-target"),
        operationDirectory: NodePath.join(f.root, "other-operation"),
      });
      expect(refused.kind).toBe("refused");
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("other-target");
    }),
);

function startPausedCopy(
  input: { sourceState: string; targetHome: string; operationDirectory: string },
  checkpoint: string,
) {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      NodeURL.fileURLToPath(new URL("./HistoryCopy.crash-fixture.mjs", import.meta.url)),
      input.sourceState,
      input.targetHome,
      input.operationDirectory,
      checkpoint,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] },
  );
  const pid = child.pid;
  if (pid === undefined) throw new Error("No captured child PID");
  const { stdout: output, stderr: errors } = child;
  const release = child.stdio[3];
  if (!output || !errors || !release || !("end" in release))
    throw new Error("Missing fixture pipes");
  process.stdout.write(`Captured fixture PID/PGID ${pid}/${pid} at launch.\n`);
  let stdout = "";
  let stderr = "";
  let reached = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const barrier = new Promise<void>((resolve, reject) => {
    output.on("data", (bytes) => {
      stdout += String(bytes);
      if (!reached && stdout.includes(`HISTORY_BARRIER ${checkpoint}\n`)) {
        reached = true;
        resolve();
      }
    });
    errors.on("data", (bytes) => {
      stderr += String(bytes);
    });
    child.once("error", reject);
    child.once("close", () => {
      if (!reached) reject(new Error(`Fixture exited before barrier: ${stdout} ${stderr}`));
    });
  });
  return {
    pid,
    barrier,
    exit,
    release: () => release.end("C"),
    output: () => stdout,
    async stop() {
      try {
        if (child.exitCode === null && child.signalCode === null) process.kill(-pid, "SIGKILL");
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause;
      }
      await exit;
      let absent = false;
      try {
        process.kill(-pid, 0);
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") absent = true;
        else throw cause;
      }
      expect(absent).toBe(true);
      process.stdout.write(`Captured fixture PID/PGID ${pid}/${pid} exited; group absent.\n`);
      for (const name of ["publisher.json", "fixture-publisher.json"]) {
        let record: unknown;
        try {
          record = JSON.parse(
            await NodeFSP.readFile(NodePath.join(input.operationDirectory, name), "utf8"),
          );
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
          throw cause;
        }
        if (
          typeof record !== "object" ||
          record === null ||
          !("pid" in record) ||
          typeof record.pid !== "number"
        )
          throw new Error("Invalid publisher PID receipt");
        let publisherAbsent = false;
        try {
          process.kill(record.pid, 0);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
            publisherAbsent = true;
          else throw cause;
        }
        expect(publisherAbsent).toBe(true);
        process.stdout.write(`Captured publisher PID ${record.pid} exited.\n`);
      }
    },
  };
}

it.effect("retains a fixture release sent before reaching the read-cut barrier", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, "read-cut")),
      (child) => Effect.promise(() => child.stop()),
    );
    child.release();
    yield* Effect.promise(() => child.barrier);
    expect(yield* Effect.promise(() => child.exit)).toEqual({ code: 0, signal: null });
    expect(child.output()).toContain('"kind":"installed"');
  }),
);

it.effect("holds one real WAL read cut while another connection commits", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, "read-cut")),
      (child) => Effect.promise(() => child.stop()),
    );
    yield* Effect.promise(() => child.barrier);
    f.database.exec("UPDATE mcp_app_model_context SET text='committed-after-read-cut'");
    child.release();
    expect(yield* Effect.promise(() => child.exit)).toEqual({ code: 0, signal: null });
    expect(child.output()).toContain('"kind":"installed"');
    const target = new NodeSqlite.DatabaseSync(
      NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      expect(target.prepare("SELECT text FROM mcp_app_model_context").get()?.text).toBe(
        "Unicode é ☃ and null",
      );
    } finally {
      target.close();
    }
    expect(f.database.prepare("SELECT text FROM mcp_app_model_context").get()?.text).toBe(
      "committed-after-read-cut",
    );
  }),
);

it.effect.each([
  "capturing",
  "read-cut",
  "captured",
  "prepared",
  "freeze-uncommitted",
  "freeze-batch",
  "ready",
  "before-rename",
  "published",
] as const)("recovers after actual SIGKILL at %s without mixing completed cuts", (checkpoint) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, checkpoint)),
      (child) => Effect.promise(() => child.stop()),
    );
    yield* Effect.promise(() => child.barrier);
    process.kill(-child.pid, "SIGKILL");
    expect((yield* Effect.promise(() => child.exit)).signal).toBe("SIGKILL");
    f.database.exec("UPDATE mcp_app_model_context SET text='changed-after-process-kill'");
    const result = yield* copyHistory(f);
    expect(result.kind, JSON.stringify(result)).toBe(
      checkpoint === "published" ? "already-installed" : "installed",
    );
    const target = new NodeSqlite.DatabaseSync(
      NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      expect(target.prepare("SELECT text FROM mcp_app_model_context").get()?.text).toBe(
        ["capturing", "read-cut"].includes(checkpoint)
          ? "changed-after-process-kill"
          : "Unicode é ☃ and null",
      );
    } finally {
      target.close();
    }
    expect(yield* copyHistory(f)).toMatchObject({ kind: "already-installed" });
  }),
);

it.effect("refuses a target created immediately before the native no-replace rename", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, "before-rename")),
      (child) => Effect.promise(() => child.stop()),
    );
    yield* Effect.promise(() => child.barrier);
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(f.targetHome);
      await NodeFSP.writeFile(NodePath.join(f.targetHome, "unrelated"), "preserve this");
    });
    child.release();
    yield* Effect.promise(() => child.exit);
    expect(child.output()).toContain('"reason":"no-replace-publication-refused"');
    expect(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(f.targetHome, "unrelated"), "utf8"),
      ),
    ).toBe("preserve this");
  }),
);

it.effect("admits one of two contending operators and preserves the winner", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const results = yield* Effect.all(
      [
        copyHistory(f),
        copyHistory({ ...f, operationDirectory: NodePath.join(f.root, "other-operation") }),
      ],
      { concurrency: 2 },
    );
    expect(results.filter((result) => result.kind === "installed")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "refused")).toHaveLength(1);
    const winner = results.find((result) => result.kind === "installed");
    if (winner?.kind !== "installed") return;
    expect(
      yield* copyHistory({ ...f, operationDirectory: winner.receipt.operationDirectory }),
    ).toMatchObject({ kind: "already-installed" });
  }),
);

it.effect("refuses projection drift before the first rebase and before the first freeze", () =>
  Effect.gen(function* () {
    for (const checkpoint of ["captured", "prepared"] as const) {
      const f = yield* fixture();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => startPausedCopy(f, checkpoint)),
        (child) => Effect.promise(() => child.stop()),
      );
      yield* Effect.promise(() => child.barrier);
      process.kill(-child.pid, "SIGKILL");
      yield* Effect.promise(() => child.exit);
      const saved: unknown = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.operationDirectory, "operation.json"), "utf8"),
        ),
      );
      if (
        typeof saved !== "object" ||
        saved === null ||
        !("stage" in saved) ||
        typeof saved.stage !== "string"
      )
        return yield* Effect.die("Missing stage receipt");
      const stage = new NodeSqlite.DatabaseSync(
        NodePath.join(saved.stage, "userdata", "statev2.sqlite"),
      );
      try {
        stage.exec(
          "UPDATE orchestration_v2_projection_messages SET payload_json=json_set(payload_json,'$.text','tampered text') WHERE message_id='screenshot'",
        );
      } finally {
        stage.close();
      }
      expect((yield* copyHistory(f)).kind).toBe("refused");
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
    }
  }),
);

it.effect.each(["external", "profile"] as const)(
  "preserves the explicit %s icon ownership",
  (ownership) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const icon =
        ownership === "external"
          ? NodePath.join(f.root, "workspace-icon.png")
          : NodePath.join(f.sourceState, "browser-artifacts", "shot.png");
      yield* Effect.promise(() => NodeFSP.writeFile(icon, png));
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.commitProjectCommand({
          commandId: CommandId.make("external-icon"),
          projectId: ProjectId.make("project:synthetic"),
          commandType: "project.update",
          acceptedAt: now,
          event: {
            eventId: EventId.make("external-icon"),
            aggregateKind: "project",
            aggregateId: ProjectId.make("project:synthetic"),
            occurredAt: "2026-10-17T10:00:00.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.meta-updated",
            payload: {
              projectId: ProjectId.make("project:synthetic"),
              faviconPath: icon,
              updatedAt: "2026-10-17T10:00:00.000Z",
            },
          },
        });
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
      );
      expect((yield* copyHistory(f)).kind).toBe("installed");
      const target = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      const journal = new NodeSqlite.DatabaseSync(
        NodePath.join(f.operationDirectory, "capture.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          target
            .prepare(
              "SELECT favicon_path FROM projection_projects WHERE project_id='project:synthetic'",
            )
            .get()?.favicon_path,
        ).toBe(
          ownership === "external"
            ? icon
            : NodePath.join(f.targetHome, "userdata", "browser-artifacts", "shot.png"),
        );
        const dependency = journal
          .prepare(
            "SELECT reference,status FROM external_dependencies WHERE project_id='project:synthetic'",
          )
          .get();
        if (ownership === "external")
          expect(dependency).toEqual({
            reference: icon,
            status: "regular-mutable-external-dependency",
          });
        else expect(dependency).toBeUndefined();
      } finally {
        target.close();
        journal.close();
      }
      yield* Effect.promise(() => NodeFSP.writeFile(icon, "changed external icon"));
      expect((yield* copyHistory(f)).kind).toBe("already-installed");
    }),
);

it.effect("reports an unavailable superseded image while retaining its original event", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const missing = `${f.sourceState}/browser-artifacts/already-dead.png`;
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      for (const [index, text] of [`![old image](${missing})`, "Current retained answer"].entries())
        yield* sink.commitCommand({
          commandId: CommandId.make(`dead:${index}`),
          threadId: ThreadId.make("parent"),
          commandType: "fixture",
          acceptedAt: now,
          effects: [],
          events: [
            {
              id: EventId.make(`dead:${index}`),
              type: "message.updated",
              threadId: ThreadId.make("parent"),
              occurredAt: now,
              payload: {
                id: MessageId.make("dead-image"),
                threadId: ThreadId.make("parent"),
                runId: null,
                nodeId: null,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
    }).pipe(
      Effect.provide(
        historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
      ),
    );
    const before = tableDigest(f.database, "orchestration_events");
    const result = yield* copyHistory(f);
    expect(result.kind).toBe("installed");
    if (result.kind !== "installed") return;
    const target = new NodeSqlite.DatabaseSync(
      NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    const journal = new NodeSqlite.DatabaseSync(
      NodePath.join(f.operationDirectory, "capture.sqlite"),
      { readOnly: true },
    );
    try {
      expect(
        tableDigest(target, "orchestration_events", {
          through: result.receipt.cut.applicationSequence,
        }),
      ).toEqual(before);
      expect(
        journal.prepare("SELECT required,status FROM asset_references WHERE path=?").get(missing),
      ).toEqual({ required: 0, status: "unavailable" });
    } finally {
      target.close();
      journal.close();
    }
  }),
);

it.effect.each(["late", "changed", "symlink", "fifo"] as const)(
  "refuses a required %s asset before publication",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const screenshot = NodePath.join(f.sourceState, "browser-artifacts", "shot.png");
      if (kind === "late") yield* Effect.promise(() => NodeFSP.unlink(screenshot));
      if (kind === "late" || kind === "changed") {
        const child = yield* Effect.acquireRelease(
          Effect.sync(() => startPausedCopy(f, "read-cut")),
          (child) => Effect.promise(() => child.stop()),
        );
        yield* Effect.promise(() => child.barrier);
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            screenshot,
            kind === "late" ? png : Buffer.concat([png, Buffer.from("changed")]),
          ),
        );
        child.release();
        expect(yield* Effect.promise(() => child.exit)).toEqual({ code: 0, signal: null });
        expect(child.output()).toContain('"kind":"refused"');
        expect(child.output()).toContain(
          kind === "late" ? "required-asset-missing-unsafe-or-late" : "changed-before-copy",
        );
      } else {
        yield* Effect.promise(() => NodeFSP.unlink(screenshot));
        if (kind === "symlink")
          yield* Effect.promise(() =>
            NodeFSP.symlink(NodePath.join(f.sourceState, "secrets", "sentinel"), screenshot),
          );
        else
          yield* Effect.promise(
            () =>
              new Promise<void>((resolve, reject) => {
                const child = NodeChildProcess.spawn("/usr/bin/mkfifo", [screenshot], {
                  detached: true,
                  stdio: "ignore",
                });
                const pid = child.pid;
                child.once("error", reject);
                child.once("close", (code) => {
                  if (code !== 0 || pid === undefined)
                    return reject(new Error("FIFO fixture failed"));
                  process.stdout.write(`Captured FIFO fixture PID/PGID ${pid}/${pid} exited.\n`);
                  resolve();
                });
              }),
          );
        expect(yield* copyHistory(f)).toMatchObject({
          kind: "refused",
          reason: "required-asset-missing-unsafe-or-late",
        });
      }
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
    }),
);

it.effect("refuses a completed capture whose owned asset bytes changed", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, "captured")),
      (child) => Effect.promise(() => child.stop()),
    );
    yield* Effect.promise(() => child.barrier);
    process.kill(-child.pid, "SIGKILL");
    yield* Effect.promise(() => child.exit);
    const receipt: unknown = JSON.parse(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(f.operationDirectory, "operation.json"), "utf8"),
      ),
    );
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("stage" in receipt) ||
      typeof receipt.stage !== "string"
    )
      return yield* Effect.die("Missing stage");
    const screenshot = NodePath.join(receipt.stage, "userdata", "browser-artifacts", "shot.png");
    yield* Effect.promise(() =>
      NodeFSP.writeFile(screenshot, Buffer.concat([png, Buffer.from("tampered")])),
    );
    expect(yield* copyHistory(f)).toMatchObject({
      kind: "refused",
      reason: "captured-asset-diverged",
    });
    expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
  }),
);

it.effect(
  "runs the thin CLI with explicit paths and reports refusal with a failing exit status",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const cli = NodeURL.fileURLToPath(new URL("../copy-history.ts", import.meta.url));
      const run = (args: readonly string[]) =>
        new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
          const child = NodeChildProcess.spawn(process.execPath, [cli, ...args], {
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
          });
          const pid = child.pid;
          let stdout = "";
          let stderr = "";
          child.stdout.on("data", (bytes) => {
            stdout += String(bytes);
          });
          child.stderr.on("data", (bytes) => {
            stderr += String(bytes);
          });
          child.once("error", reject);
          child.once("close", (code) => {
            if (pid === undefined) return reject(new Error("No CLI PID"));
            process.stdout.write(`Captured CLI PID/PGID ${pid}/${pid} exited ${code}.\n`);
            if (code === null) return reject(new Error(stderr));
            resolve({ code, stdout });
          });
        });
      const installed = yield* Effect.promise(() =>
        run([
          "--source-state",
          f.sourceState,
          "--target-home",
          f.targetHome,
          "--operation-directory",
          f.operationDirectory,
        ]),
      );
      expect(installed.code).toBe(0);
      expect(installed.stdout).toContain(`installed: ${f.targetHome}`);
      const publisher: unknown = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.operationDirectory, "publisher.json"), "utf8"),
        ),
      );
      if (
        typeof publisher !== "object" ||
        publisher === null ||
        !("pid" in publisher) ||
        typeof publisher.pid !== "number"
      )
        return yield* Effect.die("Missing CLI publisher receipt");
      const publisherPid = publisher.pid;
      expect(() => process.kill(publisherPid, 0)).toThrow();
      process.stdout.write(`Captured CLI publisher PID ${publisher.pid} exited.\n`);
      const refused = yield* Effect.promise(() =>
        run([
          "--source-state",
          f.sourceState,
          "--target-home",
          f.targetHome,
          "--operation-directory",
          NodePath.join(f.root, "different-operation"),
        ]),
      );
      expect(refused.code).toBe(1);
      expect(refused.stdout).toContain("History copy refused: target-already-exists");
    }),
);

it.effect.each([false, true])(
  "seals time after a run committed after initial claim, interrupted retry %s",
  (interrupted) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => startPausedCopy(f, "capturing")),
        (child) => Effect.promise(() => child.stop()),
      );
      yield* Effect.promise(() => child.barrier);
      const claimed: unknown = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.operationDirectory, "operation.json"), "utf8"),
        ),
      );
      if (
        typeof claimed !== "object" ||
        claimed === null ||
        !("phase" in claimed) ||
        claimed.phase !== "capturing"
      )
        return yield* Effect.die("Missing initial claim phase");
      const created = yield* Effect.gen(function* () {
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("queue"),
        );
        const original = projection.runs.find((run) => run.ordinal === 1);
        const node = projection.nodes.find((node) => node.id === original?.rootNodeId);
        const message = projection.messages.find(
          (message) => message.id === original?.userMessageId,
        );
        if (original === undefined || node === undefined || message === undefined)
          return yield* Effect.die("Missing queued source fixture");
        const committedAt = DateTime.nowUnsafe();
        const runId = RunId.make("after-initial-claim");
        const nodeId = NodeId.make("after-initial-claim-node");
        const messageId = MessageId.make("after-initial-claim-message");
        yield* (yield* EventSink.EventSinkV2).commitCommand({
          commandId: CommandId.make("after-initial-claim"),
          threadId: projection.thread.id,
          commandType: "fixture",
          acceptedAt: committedAt,
          effects: [],
          events: [
            {
              id: EventId.make("after-claim-message"),
              type: "message.updated",
              threadId: projection.thread.id,
              occurredAt: committedAt,
              payload: {
                ...message,
                id: messageId,
                runId,
                nodeId,
                text: "Committed after the copy was first claimed",
                createdAt: committedAt,
                updatedAt: committedAt,
              },
            },
            {
              id: EventId.make("after-claim-node"),
              type: "node.updated",
              threadId: projection.thread.id,
              occurredAt: committedAt,
              payload: { ...node, id: nodeId, runId, rootNodeId: nodeId, startedAt: committedAt },
            },
            {
              id: EventId.make("after-claim-run"),
              type: "run.created",
              threadId: projection.thread.id,
              occurredAt: committedAt,
              payload: {
                ...original,
                id: runId,
                ordinal: 999,
                userMessageId: messageId,
                rootNodeId: nodeId,
                queueHeld: false,
                queuePosition: 999,
                requestedAt: committedAt,
              },
            },
          ],
        });
        return DateTime.formatIso(committedAt);
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
      );
      expect("frozenAt" in claimed).toBe(false);
      if (interrupted) process.kill(-child.pid, "SIGKILL");
      else child.release();
      yield* Effect.promise(() => child.exit);
      const result = yield* copyHistory(f);
      expect(result.kind).toBe(interrupted ? "installed" : "already-installed");
      if (result.kind === "refused") return;
      const target = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      try {
        const row = target
          .prepare(
            "SELECT requested_at,completed_at FROM orchestration_v2_projection_runs WHERE run_id='after-initial-claim'",
          )
          .get();
        expect(row?.requested_at).toBe(created);
        expect(typeof row?.completed_at).toBe("string");
        if (typeof row?.completed_at !== "string") return;
        expect(Date.parse(row.completed_at)).toBeGreaterThanOrEqual(Date.parse(created));
        expect(row.completed_at).toBe(result.receipt.frozenAt);
      } finally {
        target.close();
      }
      const retry = yield* copyHistory(f);
      expect(retry.kind).toBe("already-installed");
      if (retry.kind !== "refused") expect(retry.receipt.frozenAt).toBe(result.receipt.frozenAt);
    }),
);

it("preserves file URI query and fragment in Markdown and structured tool references", () => {
  const source = "/source/browser-artifacts/clip.mp4";
  const destination = "/target/userdata/browser-artifacts/clip.mp4";
  const uri = `file://${source}?download=1#t=10,20`;
  const expected = `file://${destination}?download=1#t=10,20`;
  const result = rewriteMarkdownAssets(`![video](${uri})`, (path) =>
    path === source ? destination : undefined,
  );
  expect(result.text).toBe(`![video](${expected})`);
  expect(
    resolveMediaSource(expected, { threadId: ThreadId.make("parent"), imageEmbed: true })
      ?.srcFragment,
  ).toBe("#t=10,20");
  for (const key of ["screenshotPath", "viewedImagePath"]) {
    expect(
      relocateHistoryValue(
        { [key]: uri },
        (path) => (path === source ? destination : undefined),
        true,
      ).value,
    ).toEqual({ [key]: expected });
  }
});

it.effect.each(["uppercase", "entities"])(
  "refuses rendered owned HTML before publication: %s",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = `${f.sourceState}/browser-artifacts/shot.png`;
      const text =
        kind === "uppercase"
          ? `<IMG SRC="${source}">`
          : `<img src="${source.replaceAll("/", "&#47;")}">`;
      yield* Effect.gen(function* () {
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("parent"),
        );
        const message = projection.messages.find((item) => item.id === "screenshot");
        if (message === undefined) return yield* Effect.die("Missing screenshot message");
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("html-reference"),
              type: "message.updated",
              threadId: projection.thread.id,
              occurredAt: now,
              payload: { ...message, text },
            },
          ],
        });
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
      );
      expect(yield* copyHistory(f)).toMatchObject({
        kind: "refused",
        reason: "unsupported-renderable-reference",
      });
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
    }),
);

it.effect.each([
  { phase: "captured", kind: "scheduled-task" },
  { phase: "prepared", kind: "scheduled-task" },
  { phase: "captured", kind: "settings" },
  { phase: "prepared", kind: "settings" },
])("refuses excluded content added after $phase: $kind", ({ phase, kind }) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const child = yield* Effect.acquireRelease(
      Effect.sync(() => startPausedCopy(f, phase)),
      (child) => Effect.promise(() => child.stop()),
    );
    yield* Effect.promise(() => child.barrier);
    process.kill(-child.pid, "SIGKILL");
    yield* Effect.promise(() => child.exit);
    const receipt: unknown = JSON.parse(
      yield* Effect.promise(() =>
        NodeFSP.readFile(NodePath.join(f.operationDirectory, "operation.json"), "utf8"),
      ),
    );
    if (
      typeof receipt !== "object" ||
      receipt === null ||
      !("stage" in receipt) ||
      typeof receipt.stage !== "string"
    )
      return yield* Effect.die("Missing stage");
    const stage = receipt.stage;
    if (kind === "settings")
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(stage, "userdata", "settings.json"), "{}"),
      );
    else {
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(receipt.stage, "userdata", "statev2.sqlite"),
      );
      try {
        const row = f.database.prepare("SELECT * FROM scheduled_tasks").get();
        if (row === undefined) return yield* Effect.die("Missing scheduled task sentinel");
        const columns = Object.keys(row);
        db.prepare(
          `INSERT INTO scheduled_tasks (${columns.map((name) => `"${name}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
        ).run(...Object.values(row));
      } finally {
        db.close();
      }
    }
    expect(yield* copyHistory(f)).toMatchObject({
      kind: "refused",
      reason: kind === "settings" ? "unclassified-package-entry" : "excluded-store-not-empty",
    });
    expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
  }),
);

it.effect("preserves file URI media fragment and query through canonical copy and rebuilds", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const source = `${f.sourceState}/browser-artifacts/clip.mp4`;
    const uri = `file://${source}?download=1#t=10,20`;
    const destination = `file://${f.targetHome}/userdata/browser-artifacts/clip.mp4?download=1#t=10,20`;
    yield* Effect.promise(() => NodeFSP.writeFile(source, "synthetic media content"));
    yield* Effect.gen(function* () {
      const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        ThreadId.make("parent"),
      );
      const message = projection.messages.find((item) => item.id === "screenshot");
      const item = projection.turnItems.find((item) => item.id === "browser-tool");
      if (message === undefined || item?.type !== "dynamic_tool")
        return yield* Effect.die("Missing media fixtures");
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            id: EventId.make("media-reference"),
            type: "message.updated",
            threadId: projection.thread.id,
            occurredAt: now,
            payload: { ...message, text: `![video](${uri})` },
          },
          {
            id: EventId.make("media-tool-reference"),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            occurredAt: now,
            payload: { ...item, output: { screenshotPath: uri } },
          },
        ],
      });
    }).pipe(
      Effect.provide(
        historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
      ),
    );
    expect(yield* copyHistory(f)).toMatchObject({ kind: "installed" });
    const db = new NodeSqlite.DatabaseSync(
      NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
      { readOnly: true },
    );
    try {
      expect(
        db
          .prepare(
            "SELECT json_extract(payload_json,'$.text') AS text FROM orchestration_v2_projection_messages WHERE message_id='screenshot'",
          )
          .get()?.text,
      ).toBe(`![video](${destination})`);
      expect(
        db
          .prepare(
            "SELECT json_extract(payload_json,'$.output.screenshotPath') AS path FROM orchestration_v2_projection_turn_items WHERE turn_item_id='browser-tool'",
          )
          .get()?.path,
      ).toBe(destination);
      expect(
        resolveMediaSource(destination, { threadId: ThreadId.make("parent"), imageEmbed: true }),
      ).toMatchObject({ kind: "video", srcFragment: "#t=10,20" });
    } finally {
      db.close();
    }
  }),
);

it.effect(
  "preserves historical provider goal defaults through strict replay without changing the source",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      for (const [id, goal] of [
        ["parent:native", "absent"],
        ["child:native", "null"],
      ] as const) {
        for (const [table, where] of [
          ["orchestration_v2_projection_provider_threads", "provider_thread_id=?"],
          [
            "orchestration_events",
            "event_type='provider-thread.updated' AND json_extract(payload_json,'$.id')=?",
          ],
        ]) {
          f.database
            .prepare(
              `UPDATE ${table} SET payload_json=${goal === "absent" ? "json_remove(payload_json,'$.goal')" : "json_set(payload_json,'$.goal',NULL)"} WHERE ${where}`,
            )
            .run(id);
        }
      }
      yield* Effect.gen(function* () {
        const projection = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("parent"),
        );
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              id: EventId.make("newer-thread-ownership"),
              threadId: projection.thread.id,
              type: "thread.metadata-updated",
              occurredAt: now,
              payload: {
                ...projection.thread,
                activeProviderThreadId: null,
                updatedAt: DateTime.makeUnsafe("2026-10-17T10:01:00.000Z"),
              },
            },
          ],
        });
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
      );
      const sourceEvents = tableDigest(f.database, "orchestration_events");
      const sourceProviders = tableDigest(
        f.database,
        "orchestration_v2_projection_provider_threads",
      );
      const mainBefore = yield* Effect.promise(() => NodeFSP.readFile(f.filename));
      const walBefore = yield* Effect.promise(() => NodeFSP.readFile(`${f.filename}-wal`));
      const result = yield* copyHistory(f);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const target = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      const journal = new NodeSqlite.DatabaseSync(
        NodePath.join(f.operationDirectory, "capture.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          tableDigest(target, "orchestration_events", {
            through: result.receipt.cut.applicationSequence,
          }),
        ).toEqual(sourceEvents);
        expect(
          target
            .prepare(
              "SELECT count(*) AS count FROM orchestration_events WHERE sequence > ? AND sequence <= ? AND event_type='provider-thread.updated' AND json_extract(payload_json,'$.id') IN ('parent:native','child:native','runless:native')",
            )
            .get(result.receipt.cut.applicationSequence, result.receipt.captureHead),
        ).toEqual({ count: 0 });
        expect(
          journal
            .prepare(
              "SELECT count,content,identities FROM source_tables WHERE name='orchestration_v2_projection_provider_threads'",
            )
            .get(),
        ).toEqual(sourceProviders);
        expect(
          journal
            .prepare(
              "SELECT changed_rows FROM replay_materializations WHERE kind='missing-provider-goal-to-null'",
            )
            .get(),
        ).toEqual({ changed_rows: 1 });
        for (const id of ["parent:native", "child:native"]) {
          expect(
            target
              .prepare(
                "SELECT json_type(payload_json,'$.goal') AS goal FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id=?",
              )
              .get(id),
          ).toEqual({ goal: "null" });
        }
        expect(
          target
            .prepare(
              "SELECT json_extract(payload_json,'$.goal') AS goal FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='runless:native'",
            )
            .get(),
        ).toEqual(
          f.database
            .prepare(
              "SELECT json_extract(payload_json,'$.goal') AS goal FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='runless:native'",
            )
            .get(),
        );
      } finally {
        target.close();
        journal.close();
      }
      expect(tableDigest(f.database, "orchestration_v2_projection_provider_threads")).toEqual(
        sourceProviders,
      );
      expect(yield* Effect.promise(() => NodeFSP.readFile(f.filename))).toEqual(mainBefore);
      expect(yield* Effect.promise(() => NodeFSP.readFile(`${f.filename}-wal`))).toEqual(walBefore);
      expect(yield* copyHistory(f)).toMatchObject({ kind: "already-installed" });
    }),
);

it.effect(
  "preserves captured project icons across incomplete baselines, nulls and deleted projects",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const icons: ReadonlyArray<typeof StoredProjectIcon.Type | null> = [
        { kind: "lucide", name: "code", color: "blue" },
        { kind: "emoji", emoji: "☃" },
        { kind: "monogram", text: "AP", color: "rose" },
        null,
      ];
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        for (const [index, projectIcon] of icons.entries()) {
          const projectId = ProjectId.make(`history-icon:${index}`);
          const updatedAt = "2026-01-02T00:00:00.000Z";
          const faviconPath = index === 0 ? `${f.sourceState}/browser-artifacts/shot.png` : null;
          const created = {
            projectId,
            title: "Preserved project",
            workspaceRoot: "/synthetic",
            defaultModelSelection: null,
            scripts: [],
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt,
          };
          for (const [name, payload] of [
            ["original", { ...created, faviconPath, projectIcon }],
            ["incomplete-baseline", created],
          ] as const) {
            const commandId = CommandId.make(`${projectId}:${name}`);
            yield* sink.commitProjectCommand({
              commandId,
              projectId,
              commandType: "fixture",
              acceptedAt: now,
              event: {
                eventId: EventId.make(commandId),
                aggregateKind: "project",
                aggregateId: projectId,
                occurredAt: updatedAt,
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload,
              },
            });
          }
          if (index === 2) {
            const commandId = CommandId.make(`${projectId}:deleted`);
            yield* sink.commitProjectCommand({
              commandId,
              projectId,
              commandType: "fixture",
              acceptedAt: now,
              event: {
                eventId: EventId.make(commandId),
                aggregateKind: "project",
                aggregateId: projectId,
                occurredAt: updatedAt,
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.deleted",
                payload: { projectId, deletedAt: updatedAt },
              },
            });
          }
          f.database
            .prepare(
              "UPDATE projection_projects SET favicon_path=?,project_icon_json=? WHERE project_id=?",
            )
            .run(faviconPath, projectIcon === null ? null : JSON.stringify(projectIcon), projectId);
        }
      }).pipe(
        Effect.provide(
          historyLayer.pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: f.filename }))),
        ),
      );
      const originals = f.database
        .prepare(
          "SELECT * FROM projection_projects WHERE project_id LIKE 'history-icon:%' ORDER BY project_id",
        )
        .all();
      const sourceProjects = tableDigest(f.database, "projection_projects");
      const result = yield* copyHistory(f);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      const journal = new NodeSqlite.DatabaseSync(
        NodePath.join(f.operationDirectory, "capture.sqlite"),
        { readOnly: true },
      );
      try {
        for (const original of originals) {
          if (original.project_id === undefined)
            return yield* Effect.die("Missing project identity");
          const relocated = original.favicon_path !== null;
          expect(
            db
              .prepare("SELECT * FROM projection_projects WHERE project_id=?")
              .get(original.project_id),
          ).toEqual({
            ...original,
            ...(relocated
              ? {
                  favicon_path: `${f.targetHome}/userdata/browser-artifacts/shot.png`,
                  updated_at: result.receipt.frozenAt,
                }
              : {}),
          });
        }
        expect(
          journal.prepare("SELECT count(*) AS count FROM project_preservations").get(),
        ).toEqual({ count: 6 });
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM orchestration_events WHERE sequence > ? AND event_type='project.meta-updated' AND command_id LIKE 'history-preserve:%'",
            )
            .get(result.receipt.cut.applicationSequence),
        ).toEqual({ count: 6 });
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_type='history.project-icons-preservation'",
            )
            .get(),
        ).toEqual({ count: 6 });
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_type='history.project-icons-preservation' AND accepted_at='2026-01-02T00:00:00.000Z'",
            )
            .get(),
        ).toEqual({ count: 4 });
      } finally {
        db.close();
        journal.close();
      }
      expect(tableDigest(f.database, "projection_projects")).toEqual(sourceProjects);
    }),
);

it.effect.each([
  "unknown-key",
  "nested-unknown-key",
  "missing-other-default",
  "duplicate-key",
  "unsafe-number",
  "malformed",
  "projection-drift",
] as const)("refuses provider goal materialization with %s without publication", (kind) =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const row = f.database
      .prepare(
        "SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id='parent:native'",
      )
      .get();
    if (typeof row?.payload_json !== "string") return yield* Effect.die("Missing provider fixture");
    const raw = JSON.parse(row.payload_json);
    delete raw.goal;
    if (kind === "unknown-key") raw.unknown = { retained: true };
    if (kind === "nested-unknown-key") raw.pendingBackgroundTasks[0].unknown = "retained";
    if (kind === "missing-other-default") delete raw.contextUsage;
    if (kind === "projection-drift") raw.lastRunOrdinal = 7;
    let payload = JSON.stringify(raw);
    if (kind === "duplicate-key")
      payload = payload.replace('"status":"active"', '"status":"closed","status":"active"');
    if (kind === "unsafe-number")
      payload = payload.replace('"firstRunOrdinal":1', '"firstRunOrdinal":9007199254740993');
    if (kind === "malformed") payload = "{";
    f.database
      .prepare(
        "UPDATE orchestration_v2_projection_provider_threads SET payload_json=? WHERE provider_thread_id='parent:native'",
      )
      .run(payload);
    const before = tableDigest(f.database, "orchestration_v2_projection_provider_threads");
    const result = yield* copyHistory(f);
    expect(result.kind).toBe("refused");
    if (kind === "projection-drift")
      expect(result).toMatchObject({ reason: "projection-replay-mismatch" });
    if (["unknown-key", "nested-unknown-key", "missing-other-default"].includes(kind))
      expect(result).toMatchObject({ reason: "provider-goal-materialization-drift" });
    if (["duplicate-key", "unsafe-number"].includes(kind))
      expect(result).toMatchObject({ reason: "noncanonical-provider-goal-payload" });
    expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
    expect(tableDigest(f.database, "orchestration_v2_projection_provider_threads")).toEqual(before);
  }),
);

it.effect(
  "recaptures after interrupted project preservation with one exact event and receipt per project",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = tableDigest(f.database, "orchestration_events");
      const prepare = NodeSqlite.DatabaseSync.prototype.prepare;
      const spy = vi
        .spyOn(NodeSqlite.DatabaseSync.prototype, "prepare")
        .mockImplementation(function (this: NodeSqlite.DatabaseSync, sql) {
          if (sql === "INSERT INTO project_preservations VALUES (?, ?, ?, ?)")
            throw new Error("Synthetic interruption after canonical preservation commit");
          return prepare.call(this, sql);
        });
      try {
        expect(yield* copyHistory(f)).toMatchObject({ kind: "refused" });
      } finally {
        spy.mockRestore();
      }
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
      const result = yield* copyHistory(f);
      expect(result.kind, JSON.stringify(result)).toBe("installed");
      if (result.kind !== "installed") return;
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(f.targetHome, "userdata", "statev2.sqlite"),
        { readOnly: true },
      );
      try {
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM orchestration_events WHERE command_id LIKE 'history-preserve:%'",
            )
            .get(),
        ).toEqual({ count: 2 });
        expect(
          db
            .prepare(
              "SELECT count(*) AS count FROM orchestration_command_receipts WHERE command_type='history.project-icons-preservation'",
            )
            .get(),
        ).toEqual({ count: 2 });
        expect(
          tableDigest(db, "orchestration_events", {
            through: result.receipt.cut.applicationSequence,
          }),
        ).toEqual(source);
      } finally {
        db.close();
      }
      expect(yield* copyHistory(f)).toMatchObject({ kind: "already-installed" });
    }),
);

it.effect.each(["receipt", "event"] as const)(
  "refuses a captured project preservation with a changed %s",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const child = yield* Effect.acquireRelease(
        Effect.sync(() => startPausedCopy(f, "captured")),
        (child) => Effect.promise(() => child.stop()),
      );
      yield* Effect.promise(() => child.barrier);
      process.kill(-child.pid, "SIGKILL");
      yield* Effect.promise(() => child.exit);
      const receipt: unknown = JSON.parse(
        yield* Effect.promise(() =>
          NodeFSP.readFile(NodePath.join(f.operationDirectory, "operation.json"), "utf8"),
        ),
      );
      if (
        typeof receipt !== "object" ||
        receipt === null ||
        !("stage" in receipt) ||
        typeof receipt.stage !== "string"
      )
        return yield* Effect.die("Missing stage");
      const db = new NodeSqlite.DatabaseSync(
        NodePath.join(receipt.stage, "userdata", "statev2.sqlite"),
      );
      try {
        if (kind === "receipt")
          db.exec(
            "UPDATE orchestration_command_receipts SET accepted_at='2026-01-01T00:00:00.000Z' WHERE command_type='history.project-icons-preservation'",
          );
        else
          db.exec(
            "UPDATE orchestration_events SET metadata_json=json_object('tampered',1) WHERE command_id LIKE 'history-preserve:%'",
          );
      } finally {
        db.close();
      }
      expect(yield* copyHistory(f)).toMatchObject({
        kind: "refused",
        reason: "unowned-or-changed-command-receipt",
      });
      expect(yield* Effect.promise(() => NodeFSP.readdir(f.root))).not.toContain("target");
    }),
);
