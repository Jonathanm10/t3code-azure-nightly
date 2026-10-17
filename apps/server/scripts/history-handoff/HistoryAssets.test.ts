// @effect-diagnostics nodeBuiltinImport:off - Tests exercise native file admission, inode independence and path mutation against synthetic directories.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EventId, MessageId, OrchestrationV2DomainEvent } from "@t3tools/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { resolveMediaSource } from "../../../../packages/client-runtime/src/mediaSource.ts";
import { extractMarkdownLinkHrefs } from "@t3tools/shared/markdownLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerSecretStore from "../../src/auth/ServerSecretStore.ts";
import * as ServerConfig from "../../src/config.ts";
import * as Orchestrator from "../../src/orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../../src/project/ProjectFaviconResolver.ts";
import * as NativeAppIconResolver from "../../src/assets/NativeAppIconResolver.ts";
import * as WorkspacePaths from "../../src/workspace/WorkspacePaths.ts";
import { issueAssetUrl, resolveAsset, ASSET_ROUTE_PREFIX } from "../../src/assets/AssetAccess.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import { copyOwnedAsset, inspectOwnedAsset } from "./HistoryAssets.ts";
import { rewriteMarkdownAssets } from "./HistoryReferences.ts";
import { layerFixture, seed, now } from "./HistoryFreeze.fixture.ts";

const decodeEvent = Schema.decodeEffect(Schema.toType(OrchestrationV2DomainEvent));
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=",
  "base64",
);
const layerAssets = Layer.mergeAll(
  WorkspacePaths.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({}),
  Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({}),
  Layer.mock(NativeAppIconResolver.NativeAppIconResolver)({}),
  ServerConfig.ServerConfig.layerTest("/synthetic", { prefix: "t3-asset-render-proof-" }),
  Layer.mock(ServerSecretStore.ServerSecretStore)({
    getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(37)),
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

it.effect(
  "retains the source event prefix and renders relocated canonical content after two rebuilds",
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(async () =>
          NodeFSP.realpath(
            await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-capture-assets-")),
          ),
        ),
        (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true })),
      );
      const sourceRoot = NodePath.join(root, "source");
      const destinationRoot = NodePath.join(root, "destination");
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(sourceRoot);
        await NodeFSP.mkdir(destinationRoot);
        await NodeFSP.writeFile(NodePath.join(sourceRoot, "screenshot.png"), png);
      });
      const admitted = yield* Effect.promise(() =>
        inspectOwnedAsset({ root: sourceRoot, relativePath: "screenshot.png" }),
      );
      const asset = yield* Effect.promise(() =>
        copyOwnedAsset({ admitted, destinationRoot, publishedRoot: destinationRoot }),
      );
      const { parent } = yield* seed();
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const text = `Retained Unicode é ☃. ![Browser screenshot](${asset.sourcePath})\nPlain provenance ${asset.sourcePath} remains text.`;
      const message = yield* decodeEvent({
        id: EventId.make("asset-original"),
        threadId: parent.id,
        occurredAt: now,
        type: "message.updated",
        payload: {
          id: MessageId.make("asset-message"),
          threadId: parent.id,
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
      });
      yield* sink.write({ events: [message] });
      const prefix = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
      if (message.type !== "message.updated") return yield* Effect.die("Wrong fixture event");
      const rebase = rewriteMarkdownAssets(message.payload.text, (path) =>
        path === asset.sourcePath ? asset.destinationPath : undefined,
      );
      expect(rebase.changes).toHaveLength(1);
      expect(rebase.text).toBe(
        `Retained Unicode é ☃. ![Browser screenshot](${asset.destinationPath})\nPlain provenance ${asset.sourcePath} remains text.`,
      );
      yield* sink.commitCommand({
        commandId: CommandId.make("asset-relocation"),
        threadId: parent.id,
        commandType: "history.asset-relocation",
        acceptedAt: now,
        effects: [],
        events: [
          {
            ...message,
            id: EventId.make("asset-relocated"),
            payload: { ...message.payload, text: rebase.text },
          },
        ],
      });
      expect(
        yield* sql`SELECT * FROM orchestration_events ORDER BY sequence LIMIT ${prefix.length}`,
      ).toEqual(prefix);
      expect(yield* sql`SELECT * FROM orchestration_v2_effect_outbox`).toEqual([]);
      for (let rebuild = 0; rebuild < 2; rebuild++) {
        yield* maintenance.rebuild;
        const projection = yield* store.getThreadProjection(parent.id);
        const saved = projection?.messages.find((item) => item.id === message.payload.id);
        expect(saved?.text).toBe(rebase.text);
        const href = extractMarkdownLinkHrefs(saved?.text ?? "")[0];
        if (href === undefined) return yield* Effect.die("Missing relocated href");
        const media = resolveMediaSource(href, { threadId: parent.id, imageEmbed: true });
        expect(media?.access).toBe("environment");
        if (media?.access !== "environment") return yield* Effect.die("No environment media");
        const issued = yield* issueAssetUrl({ resource: media.resource });
        expect(issued.imageDimensions).toEqual({ width: 1, height: 1 });
        const suffix = issued.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const resolved = yield* resolveAsset(
          suffix.slice(0, separator),
          suffix.slice(separator + 1),
        );
        expect(resolved?.kind).toBe("file");
        if (resolved?.kind !== "file") return yield* Effect.die("No file asset");
        expect(resolved.path).toBe(asset.destinationPath);
        expect(yield* Effect.promise(() => NodeFSP.readFile(resolved.path))).toEqual(png);
      }
      expect(yield* Effect.promise(() => NodeFSP.readFile(asset.sourcePath))).toEqual(png);
      const sourceInfo = yield* Effect.promise(() => NodeFSP.stat(asset.sourcePath));
      const destinationInfo = yield* Effect.promise(() => NodeFSP.stat(asset.destinationPath));
      expect(sourceInfo.ino).not.toBe(destinationInfo.ino);
    }).pipe(
      Effect.provide(Layer.mergeAll(layerFixture, layerAssets)),
      Effect.provideService(HostProcess.HomeDirectory, "/synthetic"),
      Effect.scoped,
    ),
);

it("refuses traversal, symlinks, missing content and a file changed after admission", async () => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-asset-admission-")),
  );
  try {
    const source = NodePath.join(root, "source");
    const destination = NodePath.join(root, "destination");
    await NodeFSP.mkdir(source);
    await NodeFSP.mkdir(destination);
    await NodeFSP.writeFile(NodePath.join(source, "screenshot.png"), png);
    const admitted = await inspectOwnedAsset({ root: source, relativePath: "screenshot.png" });
    await NodeFSP.writeFile(admitted.sourcePath, Buffer.concat([png, Buffer.from("changed")]));
    await expect(
      copyOwnedAsset({ admitted, destinationRoot: destination, publishedRoot: destination }),
    ).rejects.toThrow("changed-before-copy");
    await expect(
      inspectOwnedAsset({ root: source, relativePath: "../outside.png" }),
    ).rejects.toThrow("unsafe-path");
    await expect(
      inspectOwnedAsset({ root: source, relativePath: "missing.png" }),
    ).rejects.toThrow();
    await NodeFSP.symlink(admitted.sourcePath, NodePath.join(source, "link.png"));
    await expect(inspectOwnedAsset({ root: source, relativePath: "link.png" })).rejects.toThrow(
      "not-regular",
    );
    await NodeFSP.symlink(destination, NodePath.join(source, "nested"));
    await expect(
      inspectOwnedAsset({ root: source, relativePath: "nested/file.png" }),
    ).rejects.toThrow("unsafe-parent");
    expect(await NodeFSP.readdir(destination)).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { recursive: true });
  }
});
