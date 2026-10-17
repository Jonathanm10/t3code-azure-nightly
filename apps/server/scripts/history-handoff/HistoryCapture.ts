// @effect-diagnostics nodeBuiltinImport:off - The offline operator streams native SQLite values and hashes without changing their storage classes.
import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import {
  assertSourceHistorySchema,
  assertDestinationHistorySchema,
  historyTables,
} from "./HistoryCapturePolicy.ts";
import { inspectOwnedAsset, copyOwnedAsset, HistoryAssetRefused } from "./HistoryAssets.ts";
import { historyReferences } from "./HistoryReferences.ts";
import { htmlRenderFromToolItem, mcpAppFromToolItem } from "@t3tools/shared/toolOutput";
import {
  parseAttachmentFileExtension,
  resolveAttachmentPathById,
} from "../../src/attachmentStore.ts";

export class HistoryCaptureRefused extends Schema.TaggedError<HistoryCaptureRefused>()(
  "HistoryCaptureRefused",
  {
    reason: Schema.String,
    entity: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
    receiptPath: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return `History capture refused: ${this.reason}`;
  }
}

const isAssetRefused = Schema.is(HistoryAssetRefused);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const rowHash = (values: readonly NodeSqlite.SQLOutputValue[]) => {
  const hash = NodeCrypto.createHash("sha256");
  for (const value of values) {
    if (value === null) {
      hash.update("n;");
      continue;
    }
    const bytes =
      typeof value === "number"
        ? Buffer.alloc(8)
        : typeof value === "bigint"
          ? Buffer.from(value.toString())
          : typeof value === "string"
            ? Buffer.from(value, "utf8")
            : Buffer.from(value);
    if (typeof value === "number") bytes.writeDoubleBE(value);
    const tag =
      typeof value === "number"
        ? "r"
        : typeof value === "bigint"
          ? "i"
          : typeof value === "string"
            ? "t"
            : "b";
    hash.update(`${tag}${bytes.length}:`).update(bytes);
  }
  return hash.digest("hex");
};

export function tableDigest(
  db: NodeSqlite.DatabaseSync,
  name: string,
  options: { readonly through?: number; readonly normalizeMetadata?: boolean } = {},
) {
  const policy = historyTables.find((table) => table.name === name);
  if (policy === undefined)
    throw new HistoryCaptureRefused({ reason: "unknown-table", entity: name });
  const columns = policy.columns.filter(
    (column) =>
      !(
        options.normalizeMetadata &&
        name === "orchestration_v2_projection_metadata" &&
        column === "updated_at"
      ),
  );
  const keys = db
    .prepare(`PRAGMA table_info(${quote(name)})`)
    .all()
    .filter((row) => typeof row.pk === "number" && row.pk > 0)
    .toSorted((a, b) => Number(a.pk) - Number(b.pk))
    .map((row) => String(row.name));
  const query = db.prepare(
    `SELECT ${columns.map(quote).join(",")} FROM ${quote(name)}${options.through === undefined ? "" : " WHERE sequence <= ?"} ORDER BY ${(keys.length === 0 ? columns : keys).map(quote).join(",")}`,
  );
  query.setReadBigInts(true);
  const content = NodeCrypto.createHash("sha256");
  const identities = NodeCrypto.createHash("sha256");
  let count = 0;
  for (const row of query.iterate(...(options.through === undefined ? [] : [options.through]))) {
    content.update(rowHash(columns.map((column) => row[column] ?? null)));
    identities.update(rowHash(keys.map((column) => row[column] ?? null)));
    count++;
  }
  return { count, content: content.digest("hex"), identities: identities.digest("hex") };
}

export function openCaptureJournal(filename: string) {
  const db = new NodeSqlite.DatabaseSync(filename);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS captured_tables (name TEXT PRIMARY KEY, count INTEGER NOT NULL, content TEXT NOT NULL, identities TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS source_tables (name TEXT PRIMARY KEY, count INTEGER NOT NULL, content TEXT NOT NULL, identities TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS asset_candidates (path TEXT PRIMARY KEY, root TEXT NOT NULL, relative_path TEXT NOT NULL, identity_json TEXT);
    CREATE TABLE IF NOT EXISTS asset_references (path TEXT PRIMARY KEY, required INTEGER NOT NULL, references_count INTEGER NOT NULL, status TEXT NOT NULL, target TEXT, sha256 TEXT);
    CREATE TABLE IF NOT EXISTS package_files (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS external_dependencies (project_id TEXT PRIMARY KEY, reference TEXT NOT NULL, resolved TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rebases (entity TEXT PRIMARY KEY, original_json TEXT NOT NULL, relocated_json TEXT NOT NULL);
  `);
  return db;
}

export async function inventoryAssetCandidates(
  sourceState: string,
  journal: NodeSqlite.DatabaseSync,
) {
  const add = journal.prepare("INSERT INTO asset_candidates VALUES (?, ?, ?, ?)");
  for (const directory of ["attachments", "browser-artifacts"]) {
    const root = NodePath.join(sourceState, directory);
    try {
      if (!(await NodeFSP.lstat(root)).isDirectory()) continue;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") continue;
      throw cause;
    }
    const visit = async (relativeDirectory: string) => {
      const entries = await NodeFSP.opendir(NodePath.join(root, relativeDirectory));
      for await (const entry of entries) {
        const relativePath = NodePath.join(relativeDirectory, entry.name);
        if (entry.isDirectory()) {
          await visit(relativePath);
          continue;
        }
        let identity: string | null = null;
        try {
          identity = JSON.stringify((await inspectOwnedAsset({ root, relativePath })).identity);
        } catch {}
        add.run(NodePath.join(root, relativePath), root, relativePath, identity);
      }
    };
    await visit("");
  }
}

export function recordReferences(input: {
  readonly value: unknown;
  readonly required: boolean;
  readonly sourceState: string;
  readonly journal: NodeSqlite.DatabaseSync;
  readonly structuredTools?: boolean;
  readonly countOccurrence?: boolean;
}) {
  const refs = historyReferences(input.value, input.structuredTools);
  if (input.required && refs.unsupportedAttachments.length !== 0)
    throw new HistoryCaptureRefused({ reason: "unsupported-attachment-type" });
  const insert = input.journal
    .prepare(`INSERT INTO asset_references VALUES (?, ?, ?, 'pending', NULL, NULL)
    ON CONFLICT(path) DO UPDATE SET required=MAX(required, excluded.required), references_count=references_count+excluded.references_count`);
  const add = (path: string) => {
    if (
      ["attachments", "browser-artifacts"].some((root) =>
        path.startsWith(`${NodePath.join(input.sourceState, root)}/`),
      )
    ) {
      insert.run(path, Number(input.required), input.countOccurrence === false ? 0 : 1);
    }
  };
  refs.paths.forEach(add);
  refs.attachments.forEach((relative) =>
    add(NodePath.join(input.sourceState, "attachments", relative)),
  );
  if (
    input.structuredTools &&
    typeof input.value === "object" &&
    input.value !== null &&
    "output" in input.value
  ) {
    const item = {
      toolName:
        "toolName" in input.value && typeof input.value.toolName === "string"
          ? input.value.toolName
          : null,
      output: input.value.output,
    };
    const id = htmlRenderFromToolItem(item)?.attachmentId ?? mcpAppFromToolItem(item)?.attachmentId;
    if (id !== undefined) {
      const extension = parseAttachmentFileExtension(id);
      if (!/^[a-z0-9_-]+$/i.test(id))
        throw new HistoryCaptureRefused({ reason: "unsafe-tool-attachment-id" });
      const resolved = resolveAttachmentPathById({
        attachmentsDir: NodePath.join(input.sourceState, "attachments"),
        attachmentId: id,
      });
      if (extension !== null)
        add(NodePath.join(input.sourceState, "attachments", `${id}.${extension}`));
      else if (resolved !== null) add(resolved);
      else if (input.required)
        throw new HistoryCaptureRefused({ reason: "missing-tool-attachment", entity: id });
      else add(NodePath.join(input.sourceState, "attachments", id));
    }
  }
}

export function captureRows(input: {
  readonly sourcePath: string;
  readonly destinationPath: string;
  readonly journal: NodeSqlite.DatabaseSync;
  readonly sourceState: string;
}) {
  const sourceInfo = NodeFS.lstatSync(input.sourcePath, { bigint: true });
  if (!sourceInfo.isFile() || NodeFS.realpathSync(input.sourcePath) !== input.sourcePath)
    throw new HistoryCaptureRefused({ reason: "unsafe-source-database" });
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      if (!NodeFS.lstatSync(`${input.sourcePath}${suffix}`).isFile())
        throw new HistoryCaptureRefused({ reason: "unsafe-source-sidecar" });
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }
  }
  const source = new NodeSqlite.DatabaseSync(input.sourcePath, { readOnly: true });
  const destination = new NodeSqlite.DatabaseSync(input.destinationPath);
  try {
    source.exec("PRAGMA query_only=ON; BEGIN");
    const policyDigest = assertSourceHistorySchema(source);
    const openedSource = NodeFS.lstatSync(input.sourcePath, { bigint: true });
    if (
      !openedSource.isFile() ||
      sourceInfo.ino !== openedSource.ino ||
      sourceInfo.dev !== openedSource.dev
    )
      throw new HistoryCaptureRefused({ reason: "source-database-replaced" });
    const schemaRows = source
      .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
      .all();
    const schemaFingerprint = rowHash([JSON.stringify(schemaRows)]);
    const head = source
      .prepare(
        "SELECT COALESCE(MAX(sequence),0) AS application, COALESCE(MAX(CASE WHEN application_event_version=2 THEN sequence END),0) AS agent FROM orchestration_events",
      )
      .get();
    if (typeof head?.application !== "number" || typeof head.agent !== "number")
      throw new HistoryCaptureRefused({ reason: "invalid-source-head" });
    assertDestinationHistorySchema(destination);
    destination.exec(
      "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; BEGIN IMMEDIATE",
    );
    let copiedRows = 0;
    for (const table of historyTables) {
      if (table.disposition !== "copy-history") continue;
      destination.exec(`DELETE FROM ${quote(table.name)}`);
      const textBytes = table.columns.map(
        (column, index) =>
          `CASE WHEN typeof(${quote(column)})='text' THEN CAST(${quote(column)} AS BLOB) END AS "__history_bytes_${index}"`,
      );
      const query = source.prepare(
        `SELECT ${table.columns.map(quote).join(",")}, ${textBytes.join(",")} FROM ${quote(table.name)} NOT INDEXED`,
      );
      query.setReadBigInts(true);
      const insert = destination.prepare(
        `INSERT INTO ${quote(table.name)} (${table.columns.map(quote).join(",")}) VALUES (${table.columns.map(() => "?").join(",")})`,
      );
      for (const row of query.iterate()) {
        if (copiedRows++ % 256 === 0) {
          const sourceCapacity = NodeFS.statfsSync(input.sourcePath);
          if (
            sourceCapacity.bavail * sourceCapacity.bsize <
            Math.max(1024 ** 3, Number(sourceInfo.size) / 10)
          )
            throw new HistoryCaptureRefused({ reason: "source-disk-space-floor" });
        }
        for (const [index, column] of table.columns.entries()) {
          const value = row[column];
          const bytes = row[`__history_bytes_${index}`];
          if (
            typeof value === "string" &&
            (!(bytes instanceof Uint8Array) || !Buffer.from(value).equals(Buffer.from(bytes)))
          )
            throw new HistoryCaptureRefused({
              reason: "unsupported-text-encoding",
              entity: table.name,
            });
        }
        insert.run(...table.columns.map((column) => row[column] ?? null));
        for (const [column, value] of Object.entries(row)) {
          if (column.startsWith("__history_bytes_") || typeof value !== "string") continue;
          let content: unknown = value;
          if (column.endsWith("_json")) {
            try {
              content = JSON.parse(value);
            } catch (cause) {
              throw new HistoryCaptureRefused({
                reason: "invalid-history-json",
                entity: `${table.name}:${column}`,
                cause,
              });
            }
            if (column === "attachments_json") content = { attachments: content };
          }
          recordReferences({
            value: content,
            required: table.name.startsWith("orchestration_v2_projection_"),
            sourceState: input.sourceState,
            journal: input.journal,
            structuredTools: column === "payload_json",
          });
        }
      }
      const original = tableDigest(source, table.name);
      if (JSON.stringify(original) !== JSON.stringify(tableDigest(destination, table.name)))
        throw new HistoryCaptureRefused({ reason: "copied-table-mismatch", entity: table.name });
      input.journal
        .prepare("INSERT INTO source_tables VALUES (?, ?, ?, ?)")
        .run(table.name, original.count, original.content, original.identities);
    }
    for (const table of historyTables)
      if (table.disposition === "empty-operational") {
        if (destination.prepare(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`).get() !== undefined)
          throw new HistoryCaptureRefused({ reason: "operational-row-copied", entity: table.name });
      }
    destination.exec("COMMIT");
    source.exec("COMMIT");
    return {
      applicationSequence: head.application,
      agentSequence: head.agent,
      policyDigest,
      schemaFingerprint,
    };
  } finally {
    source.close();
    destination.close();
  }
}

const candidateSchema = Schema.Struct({
  path: Schema.String,
  root: Schema.String,
  relative_path: Schema.String,
  identity_json: Schema.NullOr(Schema.String),
});
const identitySchema = Schema.Struct({
  device: Schema.String,
  inode: Schema.String,
  size: Schema.String,
  modified: Schema.String,
  changed: Schema.String,
  mode: Schema.String,
});
const decodeCandidate = Schema.decodeUnknownSync(candidateSchema);
const decodeIdentity = Schema.decodeUnknownSync(Schema.fromJsonString(identitySchema));
export async function captureAssets(input: {
  readonly sourceState: string;
  readonly stageState: string;
  readonly targetState: string;
  readonly journal: NodeSqlite.DatabaseSync;
}) {
  const refs = input.journal.prepare("SELECT path,required FROM asset_references ORDER BY path");
  for (const reference of refs.iterate()) {
    if (typeof reference.path !== "string")
      throw new HistoryCaptureRefused({ reason: "invalid-asset-reference" });
    const raw = input.journal
      .prepare("SELECT * FROM asset_candidates WHERE path=?")
      .get(reference.path);
    if (raw === undefined || raw.identity_json === null) {
      input.journal
        .prepare("UPDATE asset_references SET status='unavailable' WHERE path=?")
        .run(reference.path);
      if (reference.required === 1)
        throw new HistoryAssetRefused({
          reason: "required-asset-missing-unsafe-or-late",
          reference: reference.path,
        });
      continue;
    }
    const candidate = decodeCandidate(raw);
    if (candidate.identity_json === null)
      throw new HistoryCaptureRefused({ reason: "invalid-asset-candidate" });
    const rootRelative = NodePath.relative(input.sourceState, candidate.root);
    const destinationRoot = NodePath.join(input.stageState, rootRelative);
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(destinationRoot, candidate.relative_path)), {
      recursive: true,
      mode: 0o700,
    });
    let copied: Awaited<ReturnType<typeof copyOwnedAsset>>;
    try {
      copied = await copyOwnedAsset({
        admitted: {
          root: candidate.root,
          relativePath: candidate.relative_path,
          sourcePath: candidate.path,
          identity: decodeIdentity(candidate.identity_json),
        },
        destinationRoot,
        publishedRoot: NodePath.join(input.targetState, rootRelative),
      });
    } catch (cause) {
      const unavailable =
        isAssetRefused(cause) ||
        (cause instanceof Error &&
          "code" in cause &&
          ["ENOENT", "EACCES", "EPERM", "ELOOP"].includes(String(cause.code)));
      if (reference.required === 1 || !unavailable) throw cause;
      await NodeFSP.rm(NodePath.join(destinationRoot, candidate.relative_path), { force: true });
      input.journal
        .prepare("UPDATE asset_references SET status='unavailable' WHERE path=?")
        .run(reference.path);
      continue;
    }

    if (/\.html?$/i.test(copied.relativePath)) {
      const content = await NodeFSP.readFile(
        NodePath.join(destinationRoot, copied.relativePath),
        "utf8",
      );
      if (content.includes(input.sourceState))
        throw new HistoryAssetRefused({
          reason: "unsupported-owned-reference-in-html",
          reference: candidate.path,
        });
    }
    input.journal
      .prepare("UPDATE asset_references SET status='copied', target=?, sha256=? WHERE path=?")
      .run(copied.destinationPath, copied.sha256, candidate.path);
  }
}
