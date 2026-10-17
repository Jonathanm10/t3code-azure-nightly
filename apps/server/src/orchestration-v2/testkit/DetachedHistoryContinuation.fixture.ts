import * as NodeOS from "node:os";
import { assert } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as TurnItemPositionStore from "../TurnItemPositionStore.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ServerSettings from "../../serverSettings.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { ClaudeBackgroundWorkBlocksQueryReplacementError } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";

export const threadId = ThreadId.make("thread:detached-history");
export const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
export const oldText = "The retained decision is café 🦉 indigo.";
export const replyText = "Confirmed. Keep the indigo decision.";
type TurnInput = Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0];

export function makeProvider(instanceId = selection.instanceId) {
  const turns: TurnInput[] = [];
  const histories: ProviderAdapter.ProviderAdapterV2HistoricalContext[] = [];
  const calls: string[] = [];
  const forbiddenNativeIds = new Set<string>();
  let generation = 0;
  const capabilities: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
  const controls = {
    inline: false,
    nativePrefix: instanceId,
    failResume: false,
    failInjection: false,
    hold: false,
    refuseStart: false,
    beforeEnsure: Effect.void,
    beforeInject: Effect.void,
    beforeStart: Effect.void,
    capabilities,
  };
  const deny = (operation: string) =>
    Effect.sync(() => {
      calls.push(operation);
      throw new Error(`Forbidden external operation ${operation}`);
    });
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId: instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(controls.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        calls.push("open");
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: instanceId,
          driver: adapter.driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: process.cwd(),
            model: selection.model,
            capabilities: controls.capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromPubSub(events),
          ensureThread: (request) =>
            Effect.gen(function* () {
              yield* controls.beforeEnsure;
              calls.push("ensure");
              assert.isNull(request.existingProviderThread?.nativeThreadRef);
              assert.isDefined(request.existingProviderThread);
              return {
                ...request.existingProviderThread,
                nativeThreadRef: {
                  driver: adapter.driver,
                  nativeId: `${instanceId}:fresh:${++generation}`,
                  strength: "strong",
                },
                status: "idle",
              };
            }),
          resumeThread: ({ providerThread }) =>
            Effect.gen(function* () {
              calls.push("resume");
              if (controls.failResume)
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: adapter.driver,
                  detail: "Synthetic resume refusal",
                });
              assert.isFalse(
                forbiddenNativeIds.has(providerThread.nativeThreadRef?.nativeId ?? ""),
              );
              assert.isTrue(
                providerThread.nativeThreadRef?.nativeId?.startsWith(
                  `${controls.nativePrefix}:fresh:`,
                ) || providerThread.nativeThreadRef?.nativeId?.startsWith(`${instanceId}:fresh:`),
              );
              return providerThread;
            }),
          injectHistory: (history) =>
            Effect.gen(function* () {
              yield* controls.beforeInject;
              histories.push(history);
              calls.push("inject");
              if (controls.failInjection)
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: adapter.driver,
                  detail: "Synthetic lost injection acknowledgment",
                });
              return !controls.inline;
            }),
          compactThread: (turn) => runtime.startTurn(turn),
          startTurn: (turn) =>
            Effect.gen(function* () {
              yield* controls.beforeStart;
              if (controls.refuseStart)
                return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: adapter.driver,
                  threadId: turn.threadId,
                  providerThreadId: turn.providerThread.id,
                  runId: turn.runId,
                  cause: new ClaudeBackgroundWorkBlocksQueryReplacementError(),
                });
              calls.push("start");
              assert.isFalse(
                forbiddenNativeIds.has(turn.providerThread.nativeThreadRef?.nativeId ?? ""),
              );
              assert.isTrue(
                turn.providerThread.nativeThreadRef?.nativeId?.startsWith(
                  `${controls.nativePrefix}:fresh:`,
                ) ||
                  turn.providerThread.nativeThreadRef?.nativeId?.startsWith(`${instanceId}:fresh:`),
              );
              turns.push(turn);
              if (controls.hold) return;
              const time = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(`turn:${turn.runId}`);
              yield* PubSub.publish(events, {
                type: "provider_turn.updated",
                driver: adapter.driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.runOrdinal,
                  status: "completed",
                  startedAt: time,
                  completedAt: time,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn_item.updated",
                driver: adapter.driver,
                turnItem: {
                  id: TurnItemId.make(`reply:${turn.runId}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turn.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: time,
                  completedAt: time,
                  updatedAt: time,
                  type: "assistant_message",
                  messageId: MessageId.make(`reply:${turn.runId}`),
                  text: replyText,
                  streaming: false,
                },
              });
              yield* PubSub.publish(events, {
                type: "turn.terminal",
                driver: adapter.driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
            }),
          steerTurn: () => deny("steer"),
          interruptTurn: () => deny("interrupt"),
          respondToRuntimeRequest: () => deny("respond"),
          readThreadSnapshot: () => deny("snapshot"),
          rollbackThread: () => deny("rollback"),
          forkThread: () => deny("fork"),
        };
        return runtime;
      }),
  };
  return { adapter, turns, histories, calls, controls, forbiddenNativeIds };
}

export const fixture = Effect.fnUntraced(function* (
  provider: ReturnType<typeof makeProvider>,
  database: typeof SqlitePersistence.layerMemory = SqlitePersistence.layerMemory,
  peers: ReadonlyArray<ReturnType<typeof makeProvider>> = [],
  registry?: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owned = yield* fs.makeTempDirectoryScoped({ prefix: "detached-history-" });
  const name = path.basename(owned);
  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const directories = (yield* fs.readDirectory(NodeOS.tmpdir())).filter((entry) =>
        entry.startsWith(`t3-orchestration-v2-replay-${name}-`),
      );
      yield* Effect.forEach(directories, (entry) =>
        fs.remove(path.join(NodeOS.tmpdir(), entry), { recursive: true }),
      );
    }).pipe(Effect.orDie),
  );
  const runtime = ProviderReplayHarness.layerWithRegistry<never>(
    {
      name,
      runtimePolicyOverride: {
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", access: { type: "fullAccess" }, networkAccess: false },
      },
    },
    registry ??
      ProviderAdapterRegistry.layerFromAdapters([
        provider.adapter,
        ...peers.map((peer) => peer.adapter),
      ]),
    { databaseLayer: database, runEffectWorker: false },
  );
  const stores = Layer.mergeAll(
    ProjectionStore.layer,
    EffectOutbox.layer,
    EventStore.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(database));
  const recovery = ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        runtime,
        stores,
        IdAllocator.layer,
        ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
      ),
    ),
  );
  return Layer.mergeAll(
    runtime,
    database,
    stores,
    recovery,
    ProjectionMaintenance.layer.pipe(Layer.provide(Layer.merge(stores, database))),
  );
}, Effect.provide(NodeServices.layer));

export const createThread = Effect.fnUntraced(function* (id = threadId) {
  yield* (yield* Orchestrator.OrchestratorV2).dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId: id,
    projectId: ProjectId.make("project:detached-history"),
    title: "Retained discussion",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

export function message(
  text: string,
  id: string,
  target = threadId,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> {
  return {
    type: "message.dispatch",
    commandId: CommandId.make(`send:${id}`),
    threadId: target,
    messageId: MessageId.make(id),
    createdBy: "user",
    creationSource: "web",
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
  };
}

export const send = Effect.fnUntraced(function* (command: ReturnType<typeof message>) {
  const result = yield* (yield* Orchestrator.OrchestratorV2).dispatch(command);
  const created = result.storedEvents.find((stored) => stored.event.type === "run.created");
  assert.isDefined(created);
  if (created.event.type !== "run.created") return yield* Effect.die("Missing run");
  return yield* settle(created.event.payload.id, command.threadId);
});

export const settle = Effect.fnUntraced(function* (runId: RunId, target = threadId) {
  const sink = yield* EventSink.EventSinkV2;
  const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
  yield* worker.drain();
  yield* sink.stream({ threadId: target }).pipe(
    Stream.filter(
      ({ event }) =>
        event.type === "run.updated" &&
        event.payload.id === runId &&
        ["waiting", "completed", "failed"].includes(event.payload.status),
    ),
    Stream.take(1),
    Stream.runDrain,
  );
  yield* worker.drain();
  const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(target);
  assert.equal(projection.runs.find((run) => run.id === runId)?.status, "completed");
  return projection;
});

export const seedRunless = Effect.fnUntraced(function* (text = oldText, target = threadId) {
  const time = yield* DateTime.now;
  const messageId = MessageId.make(`runless:${target}`);
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`runless:${target}`),
        type: "turn-item.updated",
        threadId: target,
        occurredAt: time,
        payload: {
          id: TurnItemId.make(`runless:${target}`),
          threadId: target,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: time,
          completedAt: time,
          updatedAt: time,
          type: "user_message",
          inputIntent: "turn_start",
          messageId,
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      },
      {
        id: EventId.make(`runless-message:${target}`),
        type: "message.updated",
        threadId: target,
        occurredAt: time,
        payload: {
          id: messageId,
          threadId: target,
          runId: null,
          nodeId: null,
          role: "user",
          createdBy: "user",
          creationSource: "web",
          text,
          attachments: [],
          streaming: false,
          createdAt: time,
          updatedAt: time,
        },
      },
    ],
  });
});

export const detach = Effect.fnUntraced(function* (
  provider: ReturnType<typeof makeProvider>,
  target = threadId,
) {
  const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(target);
  const now = yield* DateTime.now;
  const events: OrchestrationV2DomainEvent[] = projection.providerThreads.map((row) => {
    if (row.nativeThreadRef?.nativeId != null)
      provider.forbiddenNativeIds.add(row.nativeThreadRef.nativeId);
    return {
      type: "provider-thread.updated",
      id: EventId.make(`detach:${row.id}`),
      threadId: target,
      occurredAt: now,
      payload: {
        ...row,
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "not_loaded",
      },
    };
  });
  events.push({
    type: "thread.metadata-updated",
    id: EventId.make(`detach:${target}`),
    threadId: target,
    occurredAt: now,
    payload: { ...projection.thread, activeProviderThreadId: null },
  });
  yield* (yield* EventSink.EventSinkV2).write({ events });
  provider.turns.length = 0;
  provider.histories.length = 0;
  provider.calls.length = 0;
});
