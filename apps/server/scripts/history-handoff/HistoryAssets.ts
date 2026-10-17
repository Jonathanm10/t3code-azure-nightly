// @effect-diagnostics nodeBuiltinImport:off - Asset capture requires no-follow descriptors, nanosecond inode checks and streaming SHA-256.
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { resolveAttachmentRelativePath } from "../../src/attachmentPaths.ts";

export class HistoryAssetRefused extends Schema.TaggedError<HistoryAssetRefused>()(
  "HistoryAssetRefused",
  {
    reason: Schema.String,
    reference: Schema.String,
  },
) {
  override get message() {
    return `History asset refused: ${this.reason}`;
  }
}

const identity = (stat: NodeFS.BigIntStats) => ({
  device: stat.dev.toString(),
  inode: stat.ino.toString(),
  size: stat.size.toString(),
  modified: stat.mtimeNs.toString(),
  changed: stat.ctimeNs.toString(),
  mode: stat.mode.toString(),
});
type AssetIdentity = ReturnType<typeof identity>;
const sameIdentity = (left: AssetIdentity, right: AssetIdentity) =>
  JSON.stringify(left) === JSON.stringify(right);
const maximumAssetBytes = 512n * 1024n * 1024n;

async function ownedPath(root: string, relativePath: string) {
  if (
    !NodePath.isAbsolute(root) ||
    NodePath.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((part) => part === "." || part === ".." || part.length === 0)
  ) {
    throw new HistoryAssetRefused({ reason: "unsafe-path", reference: relativePath });
  }
  const resolved = resolveAttachmentRelativePath({ attachmentsDir: root, relativePath });
  if (resolved === null)
    throw new HistoryAssetRefused({ reason: "unsafe-path", reference: relativePath });
  const rootInfo = await NodeFSP.lstat(root, { bigint: true });
  if (!rootInfo.isDirectory() || (await NodeFSP.realpath(root)) !== root) {
    throw new HistoryAssetRefused({ reason: "unsafe-root", reference: relativePath });
  }
  let parent = root;
  for (const part of relativePath.split("/").slice(0, -1)) {
    parent = NodePath.join(parent, part);
    const info = await NodeFSP.lstat(parent, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new HistoryAssetRefused({ reason: "unsafe-parent", reference: relativePath });
    }
  }
  return resolved;
}

export async function inspectOwnedAsset(input: {
  readonly root: string;
  readonly relativePath: string;
}) {
  const sourcePath = await ownedPath(input.root, input.relativePath);
  const stat = await NodeFSP.lstat(sourcePath, { bigint: true });
  if (!stat.isFile() || stat.ino === 0n) {
    throw new HistoryAssetRefused({ reason: "not-regular", reference: input.relativePath });
  }
  if (stat.size > maximumAssetBytes) {
    throw new HistoryAssetRefused({ reason: "asset-too-large", reference: input.relativePath });
  }
  return { ...input, sourcePath, identity: identity(stat) };
}

async function digestFile(handle: NodeFSP.FileHandle) {
  const hash = NodeCrypto.createHash("sha256");
  const buffer = Buffer.alloc(256 * 1024);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (BigInt(position) > maximumAssetBytes)
      throw new HistoryAssetRefused({ reason: "asset-too-large", reference: "" });
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { hash: hash.digest("hex"), size: position };
}

export async function copyOwnedAsset(input: {
  readonly admitted: Awaited<ReturnType<typeof inspectOwnedAsset>>;
  readonly destinationRoot: string;
  readonly publishedRoot: string;
}) {
  const { admitted } = input;
  const before = await inspectOwnedAsset(admitted);
  if (!sameIdentity(before.identity, admitted.identity)) {
    throw new HistoryAssetRefused({
      reason: "changed-before-copy",
      reference: admitted.relativePath,
    });
  }
  const destinationPath = await ownedPath(input.destinationRoot, admitted.relativePath);
  const source = await NodeFSP.open(
    admitted.sourcePath,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const opened = await source.stat({ bigint: true });
    if (!opened.isFile() || !sameIdentity(identity(opened), admitted.identity)) {
      throw new HistoryAssetRefused({
        reason: "changed-at-open",
        reference: admitted.relativePath,
      });
    }
    const destination = await NodeFSP.open(destinationPath, "wx", 0o600);
    let copiedHash: string;
    try {
      const targetInfo = await destination.stat({ bigint: true });
      if (targetInfo.dev === opened.dev && targetInfo.ino === opened.ino) {
        throw new HistoryAssetRefused({ reason: "shared-inode", reference: admitted.relativePath });
      }
      const hash = NodeCrypto.createHash("sha256");
      const buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        if (BigInt(position + bytesRead) > BigInt(admitted.identity.size)) {
          throw new HistoryAssetRefused({
            reason: "changed-during-copy",
            reference: admitted.relativePath,
          });
        }
        hash.update(buffer.subarray(0, bytesRead));
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            buffer,
            written,
            bytesRead - written,
            position + written,
          );
          if (result.bytesWritten === 0)
            throw new HistoryAssetRefused({
              reason: "short-write",
              reference: admitted.relativePath,
            });
          written += result.bytesWritten;
        }
        position += bytesRead;
      }
      copiedHash = hash.digest("hex");
      const sourceAgain = await digestFile(source);
      const after = await inspectOwnedAsset(admitted);
      if (
        position !== Number(admitted.identity.size) ||
        sourceAgain.hash !== copiedHash ||
        sourceAgain.size !== position ||
        !sameIdentity(identity(await source.stat({ bigint: true })), admitted.identity) ||
        !sameIdentity(after.identity, admitted.identity)
      ) {
        throw new HistoryAssetRefused({
          reason: "changed-during-copy",
          reference: admitted.relativePath,
        });
      }
      await destination.sync();
    } finally {
      await destination.close();
    }
    const target = await NodeFSP.open(
      destinationPath,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      if ((await digestFile(target)).hash !== copiedHash) {
        throw new HistoryAssetRefused({
          reason: "destination-hash-mismatch",
          reference: admitted.relativePath,
        });
      }
    } finally {
      await target.close();
    }
    return {
      sourcePath: admitted.sourcePath,
      destinationPath: NodePath.join(input.publishedRoot, admitted.relativePath),
      relativePath: admitted.relativePath,
      sourceIdentity: admitted.identity,
      sha256: copiedHash,
    };
  } finally {
    await source.close();
  }
}
