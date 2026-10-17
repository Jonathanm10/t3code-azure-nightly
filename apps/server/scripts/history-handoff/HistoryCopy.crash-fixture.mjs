import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

const [sourceState, targetHome, operationDirectory, checkpoint] = process.argv.slice(2);
if (!sourceState || !targetHome || !operationDirectory || !checkpoint)
  throw new Error("Missing synthetic fixture arguments");
if (
  NodeFS.readFileSync(
    NodePath.join(NodePath.dirname(sourceState), ".history-synthetic-fixture"),
    "utf8",
  ) !== "synthetic"
)
  throw new Error("Not an owned synthetic fixture");
const stop = (point) => {
  NodeFS.writeSync(1, `HISTORY_BARRIER ${point}\n`);
  const release = Buffer.alloc(1);
  if (NodeFS.readSync(3, release, 0, 1, null) !== 1 || release.toString() !== "C")
    throw new Error("Missing or invalid fixture release");
};
const originalRename = NodeFS.promises.rename;
NodeFS.promises.rename = async (from, to) => {
  await originalRename(from, to);
  if (String(to) === NodePath.join(operationDirectory, "operation.json")) {
    const phase = JSON.parse(await NodeFS.promises.readFile(to, "utf8")).phase;
    if (phase === checkpoint) stop(phase);
  }
};
const openDatabases = new Set();
const originalClose = NodeSqlite.DatabaseSync.prototype.close;
NodeSqlite.DatabaseSync.prototype.close = function () {
  const result = originalClose.call(this);
  openDatabases.delete(this);
  return result;
};
let freezeBatchPending = false;
const originalPrepare = NodeSqlite.DatabaseSync.prototype.prepare;
NodeSqlite.DatabaseSync.prototype.prepare = function (sql) {
  openDatabases.add(this);
  const statement = originalPrepare.call(this, sql);
  if (checkpoint === "read-cut" && sql.includes(" AS application")) {
    const get = statement.get.bind(statement);
    statement.get = (...args) => {
      const result = get(...args);
      stop("read-cut");
      return result;
    };
  }
  const run = statement.run.bind(statement);
  statement.run = (...args) => {
    const result = run(...args);
    if (sql.includes("INSERT INTO history_handoff.batches")) {
      freezeBatchPending = true;
      if (checkpoint === "freeze-uncommitted") stop("freeze-uncommitted");
    }
    if (
      freezeBatchPending &&
      sql.trim().toUpperCase() === "COMMIT" &&
      checkpoint === "freeze-batch"
    )
      stop("freeze-batch");
    return result;
  };
  return statement;
};
const nativeSpawn = NodeChildProcess.default.spawn;
NodeChildProcess.default.spawn = (...args) => {
  if (args[0] === "/usr/bin/python3") {
    const operation = JSON.parse(
      NodeFS.readFileSync(NodePath.join(operationDirectory, "operation.json"), "utf8"),
    );
    for (const database of openDatabases) {
      const files = originalPrepare.call(database, "PRAGMA database_list").all();
      if (files.some((file) => String(file.file).startsWith(`${operation.stage}/`)))
        throw new Error("A package database is still open at publication");
    }
    NodeFS.writeSync(1, "PACKAGE_DATABASES_CLOSED\n");
  }

  if (args[0] === "/usr/bin/python3" && checkpoint === "before-rename") stop("before-rename");
  const child = nativeSpawn(...args);
  if (args[0] === "/usr/bin/python3") {
    NodeFS.writeFileSync(
      NodePath.join(operationDirectory, "fixture-publisher.json"),
      JSON.stringify({ pid: child.pid }),
    );
    if (checkpoint === "published") child.once("close", () => stop("published"));
  }
  return child;
};
NodeModule.syncBuiltinESMExports();
const { copyHistory } = await import("./HistoryCopy.ts");
const result = await Effect.runPromise(
  copyHistory({ sourceState, targetHome, operationDirectory }),
);
NodeFS.writeSync(1, `HISTORY_RESULT ${JSON.stringify(result)}\n`);
