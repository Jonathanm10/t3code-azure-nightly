// @effect-diagnostics nodeBuiltinImport:off - Publication requires exclusive directory creation, file fsync and the macOS no-replace rename primitive.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import type * as NodeSqlite from "node:sqlite";
import { HistoryCaptureRefused } from "./HistoryCapture.ts";

const cutSchema = Schema.Struct({
  applicationSequence: Schema.Number,
  agentSequence: Schema.Number,
  policyDigest: Schema.String,
  schemaFingerprint: Schema.String,
});
const operationBase = {
  version: Schema.Literal(1),
  id: Schema.String,
  sourceState: Schema.String,
  targetHome: Schema.String,
  operationDirectory: Schema.String,
  stage: Schema.String,
};
export const operationSchema = Schema.Union([
  Schema.Struct({ ...operationBase, phase: Schema.Literal("capturing") }),
  Schema.Struct({
    ...operationBase,
    frozenAt: Schema.String,
    phase: Schema.Literal("captured"),
    cut: cutSchema,
    captureHead: Schema.Number,
  }),
  Schema.Struct({
    ...operationBase,
    frozenAt: Schema.String,
    phase: Schema.Literal("prepared"),
    cut: cutSchema,
    captureHead: Schema.Number,
    freezeHead: Schema.Number,
  }),
  Schema.Struct({
    ...operationBase,
    frozenAt: Schema.String,
    phase: Schema.Literals(["ready", "installed"]),
    cut: cutSchema,
    captureHead: Schema.Number,
    freezeHead: Schema.Number,
    packageHash: Schema.String,
  }),
]);
export type HistoryOperation = typeof operationSchema.Type;
const decodePublisher = Schema.decodeUnknownSync(
  Schema.Struct({
    pid: Schema.Number,
    pgid: Schema.Number,
    exitCode: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
);
const decodeActiveOwner = Schema.decodeUnknownSync(
  Schema.Struct({ pid: Schema.Number, id: Schema.String }),
);
const decodeOperation = Schema.decodeUnknownSync(Schema.fromJsonString(operationSchema));
const encodeOperation = Schema.encodeSync(Schema.fromJsonString(operationSchema));
const receiptName = ".history-handoff-receipt.json";
export async function syncDirectory(path: string) {
  const handle = await NodeFSP.open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function persistOperation(operation: HistoryOperation) {
  const path = NodePath.join(operation.operationDirectory, "operation.json");
  const temporary = `${path}.${NodeCrypto.randomUUID()}.tmp`;
  const handle = await NodeFSP.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(encodeOperation(operation));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await NodeFSP.rename(temporary, path);
  await syncDirectory(operation.operationDirectory);
}
const exists = async (path: string) => {
  try {
    await NodeFSP.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
};
async function canonicalNewPath(path: string) {
  if (!NodePath.isAbsolute(path) || NodePath.normalize(path) !== path)
    throw new HistoryCaptureRefused({ reason: "noncanonical-input-path" });
  return NodePath.join(await NodeFSP.realpath(NodePath.dirname(path)), NodePath.basename(path));
}
export async function claimHistoryOperation(input: {
  readonly sourceState: string;
  readonly targetHome: string;
  readonly operationDirectory: string;
}) {
  if (![input.sourceState, input.targetHome, input.operationDirectory].every(NodePath.isAbsolute))
    throw new HistoryCaptureRefused({ reason: "absolute-paths-required" });
  const sourceState = await NodeFSP.realpath(input.sourceState);
  if (sourceState !== input.sourceState)
    throw new HistoryCaptureRefused({ reason: "source-path-alias" });
  const targetHome = await canonicalNewPath(input.targetHome);
  const operationDirectory = await canonicalNewPath(input.operationDirectory);
  const paths = [sourceState, targetHome, operationDirectory];
  for (const a of paths)
    for (const b of paths)
      if (a !== b && a.startsWith(`${b}/`))
        throw new HistoryCaptureRefused({ reason: "overlapping-paths" });
  if (new Set(paths).size !== paths.length)
    throw new HistoryCaptureRefused({ reason: "overlapping-paths" });
  if (!NodePath.isAbsolute(input.sourceState) || !(await NodeFSP.lstat(sourceState)).isDirectory())
    throw new HistoryCaptureRefused({ reason: "invalid-source-directory" });
  let operation: HistoryOperation;
  if (await exists(operationDirectory)) {
    const stat = await NodeFSP.lstat(operationDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
      throw new HistoryCaptureRefused({ reason: "unowned-operation-directory" });
    operation = decodeOperation(
      await NodeFSP.readFile(NodePath.join(operationDirectory, "operation.json"), "utf8"),
    );
    if (
      operation.sourceState !== sourceState ||
      operation.targetHome !== targetHome ||
      operation.operationDirectory !== operationDirectory
    )
      throw new HistoryCaptureRefused({ reason: "operation-input-mismatch" });
  } else {
    if (await exists(targetHome))
      throw new HistoryCaptureRefused({ reason: "target-already-exists" });
    await NodeFSP.mkdir(operationDirectory, { mode: 0o700 });
    const id = NodeCrypto.randomUUID();
    operation = {
      version: 1,
      id,
      sourceState,
      targetHome,
      operationDirectory,
      stage: NodePath.join(
        NodePath.dirname(targetHome),
        `.${NodePath.basename(targetHome)}.history-${id}`,
      ),
      phase: "capturing",
    };
    await persistOperation(operation);
  }
  if (!/^[a-f0-9-]{36}$/.test(operation.id))
    throw new HistoryCaptureRefused({ reason: "invalid-operation-id" });
  const expectedStage = NodePath.join(
    NodePath.dirname(targetHome),
    `.${NodePath.basename(targetHome)}.history-${operation.id}`,
  );
  if (operation.stage !== expectedStage)
    throw new HistoryCaptureRefused({ reason: "stage-owner-mismatch" });
  const publisherPath = NodePath.join(operationDirectory, "publisher.json");
  if (await exists(publisherPath)) {
    const publisher = decodePublisher(JSON.parse(await NodeFSP.readFile(publisherPath, "utf8")));
    if (publisher.exitCode === undefined) {
      let running = true;
      try {
        process.kill(publisher.pid, 0);
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") running = false;
        else throw cause;
      }
      if (running) throw new HistoryCaptureRefused({ reason: "publisher-in-use" });
    }
  }
  const active = NodePath.join(operationDirectory, "active");
  if (await exists(active)) {
    const prior = decodeActiveOwner(
      JSON.parse(await NodeFSP.readFile(NodePath.join(active, "owner.json"), "utf8")),
    );
    if (prior.id !== operation.id)
      throw new HistoryCaptureRefused({ reason: "active-owner-mismatch" });
    let running = true;
    try {
      process.kill(prior.pid, 0);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") running = false;
      else throw cause;
    }
    if (running) throw new HistoryCaptureRefused({ reason: "operation-in-use" });
    await NodeFSP.rm(active, { recursive: true });
  }
  await NodeFSP.mkdir(active, { mode: 0o700 });
  await NodeFSP.writeFile(
    NodePath.join(active, "owner.json"),
    JSON.stringify({ pid: process.pid, id: operation.id }),
    { flag: "wx", mode: 0o600 },
  );
  const claim = NodePath.join(
    NodePath.dirname(targetHome),
    `.${NodePath.basename(targetHome)}.history-claim`,
  );
  try {
    try {
      await NodeFSP.mkdir(claim, { mode: 0o700 });
      await NodeFSP.writeFile(
        NodePath.join(claim, "owner.json"),
        JSON.stringify({ id: operation.id, operationDirectory }),
        { flag: "wx", mode: 0o600 },
      );
      await syncDirectory(claim);
      await syncDirectory(NodePath.dirname(claim));
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
      const claimInfo = await NodeFSP.lstat(claim);
      if (!claimInfo.isDirectory() || claimInfo.isSymbolicLink() || (claimInfo.mode & 0o077) !== 0)
        throw new HistoryCaptureRefused({ reason: "unsafe-target-claim" });
      const owner: unknown = JSON.parse(
        await NodeFSP.readFile(NodePath.join(claim, "owner.json"), "utf8"),
      );
      if (JSON.stringify(owner) !== JSON.stringify({ id: operation.id, operationDirectory }))
        throw new HistoryCaptureRefused({ reason: "target-claimed-by-another-operation" });
    }
    return { operation, release: () => NodeFSP.rm(active, { recursive: true }) };
  } catch (cause) {
    await NodeFSP.rm(active, { recursive: true });
    throw cause;
  }
}

export async function restartOwnedStage(operation: HistoryOperation) {
  if (operation.phase !== "capturing")
    throw new HistoryCaptureRefused({ reason: "completed-capture-must-not-restart" });
  if (await exists(operation.targetHome))
    throw new HistoryCaptureRefused({ reason: "target-already-exists" });
  if (await exists(operation.stage)) {
    const stat = await NodeFSP.lstat(operation.stage);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await NodeFSP.readFile(NodePath.join(operation.stage, ".history-owner"), "utf8")) !==
        operation.id
    )
      throw new HistoryCaptureRefused({ reason: "unowned-stage" });
    await NodeFSP.rm(operation.stage, { recursive: true });
  }
  await NodeFSP.mkdir(operation.stage, { mode: 0o700 });
  await NodeFSP.writeFile(NodePath.join(operation.stage, ".history-owner"), operation.id, {
    flag: "wx",
    mode: 0o600,
  });
  await NodeFSP.mkdir(NodePath.join(operation.stage, "userdata"), { mode: 0o700 });
}

async function fileDigest(path: string) {
  const before = await NodeFSP.lstat(path, { bigint: true });
  if (!before.isFile()) throw new HistoryCaptureRefused({ reason: "nonregular-package-file" });
  const handle = await NodeFSP.open(path, "r");
  const hash = NodeCrypto.createHash("sha256");
  try {
    for await (const bytes of handle.createReadStream({ autoClose: false })) hash.update(bytes);
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new HistoryCaptureRefused({ reason: "package-changed-during-audit" });
    return { sha256: hash.digest("hex"), size: Number(after.size) };
  } finally {
    await handle.close();
  }
}
export async function packageDigest(
  root: string,
  journal: NodeSqlite.DatabaseSync,
  record: { readonly targetHome: string } | false,
) {
  const allowedFiles = new Set([".history-owner", "userdata/statev2.sqlite"]);
  const allowedDirectories = new Set(["userdata"]);
  if (record) {
    for (const asset of journal
      .prepare("SELECT target FROM asset_references WHERE status='copied'")
      .iterate()) {
      if (typeof asset.target !== "string" || !asset.target.startsWith(`${record.targetHome}/`))
        throw new HistoryCaptureRefused({ reason: "invalid-captured-asset-target" });
      const relative = NodePath.relative(record.targetHome, asset.target);
      allowedFiles.add(relative);
      for (
        let directory = NodePath.dirname(relative);
        directory !== ".";
        directory = NodePath.dirname(directory)
      )
        allowedDirectories.add(directory);
    }
    journal.exec("DELETE FROM package_files");
  }
  let count = 0;
  const walk = async (relative: string) => {
    const dir = await NodeFSP.opendir(NodePath.join(root, relative));
    for await (const item of dir) {
      const name = NodePath.join(relative, item.name);
      if (name === receiptName) continue;
      if (item.isSymbolicLink()) throw new HistoryCaptureRefused({ reason: "symlink-in-package" });
      if (record && !(item.isDirectory() ? allowedDirectories : allowedFiles).has(name))
        throw new HistoryCaptureRefused({ reason: "unclassified-package-entry", entity: name });
      if (item.isDirectory()) {
        if (record)
          journal.prepare("INSERT INTO package_files VALUES (?, 'directory', 0)").run(name);
        else if (
          journal.prepare("SELECT sha256 FROM package_files WHERE path=?").get(name)?.sha256 !==
          "directory"
        )
          throw new HistoryCaptureRefused({ reason: "destination-diverged" });
        count++;
        await walk(name);
        continue;
      }
      const digest = await fileDigest(NodePath.join(root, name));
      if (record)
        journal
          .prepare("INSERT INTO package_files VALUES (?, ?, ?)")
          .run(name, digest.sha256, digest.size);
      else {
        const expected = journal
          .prepare("SELECT sha256,size FROM package_files WHERE path=?")
          .get(name);
        if (expected?.sha256 !== digest.sha256 || expected.size !== digest.size)
          throw new HistoryCaptureRefused({ reason: "destination-diverged" });
      }
      count++;
    }
  };
  await walk("");
  if (record && count !== allowedFiles.size + allowedDirectories.size)
    throw new HistoryCaptureRefused({ reason: "missing-package-entry" });
  const expectedCount = journal.prepare("SELECT count(*) AS count FROM package_files").get()?.count;
  if (count !== expectedCount) throw new HistoryCaptureRefused({ reason: "destination-diverged" });
  const hash = NodeCrypto.createHash("sha256");
  for (const row of journal.prepare("SELECT * FROM package_files ORDER BY path").iterate())
    hash.update(JSON.stringify(row));
  return hash.digest("hex");
}

export async function recognizeInstalled(
  operation: HistoryOperation,
  journal: NodeSqlite.DatabaseSync,
) {
  if (!(await exists(operation.targetHome))) return false;
  const targetInfo = await NodeFSP.lstat(operation.targetHome);
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink())
    throw new HistoryCaptureRefused({ reason: "unsafe-existing-target" });
  if (operation.phase !== "ready" && operation.phase !== "installed")
    throw new HistoryCaptureRefused({ reason: "target-already-exists" });
  const receipt = await NodeFSP.readFile(NodePath.join(operation.targetHome, receiptName), "utf8");
  if (receipt !== encodeOperation({ ...operation, phase: "ready" }))
    throw new HistoryCaptureRefused({ reason: "installed-receipt-mismatch" });
  if ((await packageDigest(operation.targetHome, journal, false)) !== operation.packageHash)
    throw new HistoryCaptureRefused({ reason: "destination-diverged" });
  return true;
}

const renameProgram = `import ctypes,os,sys
lib=ctypes.CDLL(None,use_errno=True)
fn=lib.renameatx_np
fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
fn.restype=ctypes.c_int
if sys.stdin.buffer.read(1)!=b"1": sys.exit(1)
if fn(-2,os.fsencode(sys.argv[1]),-2,os.fsencode(sys.argv[2]),4)!=0:
 sys.exit(ctypes.get_errno() or 1)
fd=os.open(os.path.dirname(sys.argv[2]),os.O_RDONLY)
os.fsync(fd)
os.close(fd)
`;
export async function publishHistory(
  operation: Extract<HistoryOperation, { phase: "ready" | "installed" }>,
  platform: string,
) {
  if (platform !== "darwin")
    throw new HistoryCaptureRefused({ reason: "no-proved-no-replace-primitive" });
  const receiptPath = NodePath.join(operation.stage, receiptName);
  const receiptText = encodeOperation({ ...operation, phase: "ready" });
  if (await exists(receiptPath)) {
    if ((await NodeFSP.readFile(receiptPath, "utf8")) !== receiptText)
      throw new HistoryCaptureRefused({ reason: "staged-receipt-mismatch" });
  } else {
    const receipt = await NodeFSP.open(receiptPath, "wx", 0o600);
    try {
      await receipt.writeFile(receiptText);
      await receipt.sync();
    } finally {
      await receipt.close();
    }
  }
  const syncTree = async (path: string) => {
    const entries = await NodeFSP.opendir(path);
    for await (const entry of entries) {
      const child = NodePath.join(path, entry.name);
      if (entry.isDirectory()) await syncTree(child);
      else {
        const handle = await NodeFSP.open(child, "r");
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
    await syncDirectory(path);
  };
  await syncTree(operation.stage);
  const exit = await new Promise<number>((resolve, reject) => {
    const child = NodeChildProcess.spawn(
      "/usr/bin/python3",
      ["-I", "-c", renameProgram, operation.stage, operation.targetHome],
      { stdio: ["pipe", "ignore", "ignore"], detached: true },
    );
    const pid = child.pid;
    const publisherPath = NodePath.join(operation.operationDirectory, "publisher.json");
    const recorded = (async () => {
      if (pid === undefined) throw new HistoryCaptureRefused({ reason: "publisher-spawn-failed" });
      const handle = await NodeFSP.open(publisherPath, "w", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid, pgid: pid }));
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(operation.operationDirectory);
    })();
    child.stdin.on("error", () => undefined);
    recorded.then(
      () => child.stdin.end("1"),
      () => child.stdin.end(),
    );
    child.once("error", reject);
    child.once("close", (code) => {
      recorded
        .then(async () => {
          await NodeFSP.writeFile(
            publisherPath,
            JSON.stringify({ pid, pgid: pid, exitCode: code }),
            { mode: 0o600 },
          );
          await NodeFSP.appendFile(
            NodePath.join(operation.operationDirectory, "publisher-exits.jsonl"),
            JSON.stringify({ pid, pgid: pid, exitCode: code }) + "\n",
          );
          resolve(code ?? -1);
        }, reject)
        .catch(reject);
    });
  });
  if (exit !== 0) throw new HistoryCaptureRefused({ reason: "no-replace-publication-refused" });
}
