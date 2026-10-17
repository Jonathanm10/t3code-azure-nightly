import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { ThreadId, CommandId, EventId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../EventSink.ts";
import * as EventStore from "../EventStore.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Recovery from "../ProviderRuntimeRecoveryService.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import {
  createThread,
  fixture,
  makeProvider,
  message,
  seedRunless,
  oldText,
  send,
  threadId,
  detach,
} from "./DetachedHistoryContinuation.fixture.ts";

vi.mock("../../checkpointing/CheckpointStore.ts", async (load) => {
  const module = await load<typeof import("../../checkpointing/CheckpointStore.ts")>();
  return {
    ...module,
    layer: Layer.mock(module.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  };
});

it.effect.each(["delta", "automatic"] as const)(
  "does not carry a cancelled %s as initial context",
  (kind) =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        yield* createThread();
        yield* seedRunless();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(message("Earlier intent.", "earlier"));
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const handoff = initial.contextHandoffs[0]!;
        const sink = yield* EventSink.EventSinkV2;
        if (kind === "delta")
          yield* sink.write({
            events: [
              {
                type: "context-handoff.updated",
                id: EventId.make("delta-carrier"),
                threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...handoff, strategy: "delta_since_target_last_seen" },
              },
            ],
          });
        else
          yield* sink.write({
            events: [
              {
                type: "message.updated",
                id: EventId.make("automatic-source"),
                threadId,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...initial.messages.find((entry) => entry.id === initial.runs[0]?.userMessageId)!,
                  createdBy: "agent",
                  creationSource: "server",
                },
              },
            ],
          });
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        const after = yield* send(message("Explicit next intent.", "next"));
        assert.notEqual(after.runs.at(-1)?.contextHandoffId, handoff.id);
        assert.isUndefined(
          after.contextHandoffs.find((entry) => entry.id === handoff.id)?.delivery,
        );
        assert.lengthOf(provider.histories, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  "native-persisted",
  "before-injection",
  "after-injection",
  "before-inline",
  "after-inline",
  "inherited-after-injection",
] as const)("preserves the accepted context after process loss at %s", (boundary) =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      if (boundary === "inherited-after-injection") {
        provider.controls.capabilities = {
          ...provider.controls.capabilities,
          threads: {
            ...provider.controls.capabilities.threads,
            canForkThread: false,
            canForkFromTurn: false,
          },
        };
        const ancestor = ThreadId.make("thread:ancestor");
        yield* createThread(ancestor);
        yield* send(message(oldText, "ancestor-message", ancestor));
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork"),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: ancestor,
          targetThreadId: threadId,
          sourcePoint: { type: "latest_stable" },
          title: "Inherited",
        });
        yield* send(message("Local fork decision.", "fork-message"));
        yield* detach(provider);
      } else {
        yield* createThread();
        yield* seedRunless();
      }
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const milestone = yield* Deferred.make<void>();
      const pause = Deferred.succeed(milestone, undefined).pipe(Effect.andThen(Effect.never));
      provider.controls.hold = true;
      provider.controls.inline = boundary === "before-inline" || boundary === "after-inline";
      if (boundary === "before-injection") provider.controls.beforeInject = pause;
      if (boundary === "before-inline") provider.controls.beforeStart = pause;
      const write = sink.write;
      const writeSpy = vi.spyOn(sink, "write").mockImplementation((input) => {
        const status =
          boundary === "native-persisted"
            ? "pending"
            : boundary === "after-injection" || boundary === "inherited-after-injection"
              ? "injected"
              : "inline";
        return (boundary === "native-persisted" ||
          boundary === "after-injection" ||
          boundary === "inherited-after-injection" ||
          boundary === "after-inline") &&
          input.events.some(
            (event) =>
              event.type === "context-handoff.updated" && event.payload.delivery?.status === status,
          )
          ? pause
          : write(input);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => writeSpy.mockRestore()));
      yield* orchestrator.dispatch(message("First explicit intent.", "first"));
      const initial = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      const execution = yield* worker.drain().pipe(Effect.forkScoped);
      yield* Deferred.await(milestone);
      const beforeLoss = yield* orchestrator.getThreadProjection(threadId);
      const native = beforeLoss.providerThreads.find((row) => row.id === initial.providerThreadId)
        ?.nativeThreadRef?.nativeId;
      assert.isString(native);
      assert.equal(
        beforeLoss.contextHandoffs.find((handoff) => handoff.id === initial.contextHandoffId)
          ?.delivery?.status,
        boundary === "native-persisted" ? undefined : "pending",
      );
      yield* Fiber.interrupt(execution);
      writeSpy.mockRestore();
      const recovered = yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      assert.equal(recovered.terminalizedRuns, 1);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === initial.id,
        )?.status,
        "cancelled",
      );
      const effects = yield* (yield* EffectOutbox.EffectOutboxV2).listByCommandId(
        message("First explicit intent.", "first").commandId,
      );
      assert.isFalse(
        effects.some((effect) => effect.status === "pending" || effect.status === "running"),
      );
      provider.controls.beforeInject = Effect.void;
      provider.controls.beforeStart = Effect.void;
      provider.controls.hold = false;
      for (let pass = 0; pass < 2; pass++)
        assert.isTrue(
          (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
        );
      const after = yield* send(message("Later explicit retry.", "retry"));
      assert.equal(after.runs.find((run) => run.id === initial.id)?.status, "cancelled");
      assert.equal(after.runs.at(-1)?.contextHandoffId, initial.contextHandoffId);
      const delivery = after.contextHandoffs.find(
        (row) => row.id === initial.contextHandoffId,
      )?.delivery;
      assert.isDefined(delivery);
      assert.notEqual(delivery.status, "pending");
      if (boundary === "native-persisted") assert.equal(delivery.nativeThreadId, native);
      else assert.notEqual(delivery.nativeThreadId, native);
      const latest = provider.histories.at(-1)!;
      assert.equal(latest.messages.filter((entry) => entry.text === oldText).length, 1);
      if (boundary === "inherited-after-injection") assert.equal(latest.messages[0]?.text, oldText);
      const count = provider.histories.length;
      yield* send(message("Next ordinary turn.", "next"));
      assert.lengthOf(provider.histories, count);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "rolls back failed acceptance and refuses unsupported context before native creation",
  () =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        yield* createThread();
        yield* seedRunless();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* EventStore.EventStoreV2;
        const before = yield* store.latestSequence();
        yield* sql`CREATE TEMP TRIGGER reject_history_acceptance BEFORE INSERT ON orchestration_v2_projection_context_handoffs BEGIN SELECT RAISE(ABORT, 'synthetic before commit'); END`;
        const failed = yield* orchestrator
          .dispatch(message("First rejected attempt.", "transaction-failure"))
          .pipe(Effect.exit);
        assert.equal(failed._tag, "Failure");
        yield* sql`DROP TRIGGER reject_history_acceptance`;
        const rejected = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(rejected.runs, 0);
        assert.lengthOf(rejected.contextHandoffs, 0);
        assert.equal(yield* store.latestSequence(), before);
        assert.deepEqual(provider.calls, []);
        provider.controls.capabilities = {
          ...provider.controls.capabilities,
          context: { ...provider.controls.capabilities.context, supportsFullThreadHandoff: false },
        };
        assert.equal(
          (yield* orchestrator
            .dispatch(message("Unsupported attempt.", "unsupported"))
            .pipe(Effect.exit))._tag,
          "Failure",
        );
        assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 0);
        assert.deepEqual(provider.calls, []);
        provider.controls.capabilities = {
          ...provider.controls.capabilities,
          context: { ...provider.controls.capabilities.context, supportsFullThreadHandoff: true },
        };
        yield* send(message("Accepted retry.", "valid"));
        assert.lengthOf(provider.histories, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("restores ready inline context after known refusal before reading the prompt", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      yield* seedRunless();
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      provider.controls.inline = true;
      provider.controls.refuseStart = true;
      yield* orchestrator.dispatch(message("Rejected before reading.", "refused"));
      yield* worker.drain();
      const refused = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(refused.runs[0]?.status, "failed");
      assert.isUndefined(refused.contextHandoffs[0]?.delivery);
      assert.lengthOf(provider.turns, 0);
      provider.controls.refuseStart = false;
      yield* send(message("Retry the intended task.", "retry"));
      assert.equal(provider.calls.filter((call) => call === "ensure").length, 1);
      assert.include(provider.turns[0]?.message.text ?? "", oldText);
      const count = provider.histories.length;
      yield* send(message("Ordinary following turn.", "next"));
      assert.lengthOf(provider.histories, count);
    }).pipe(Effect.provide(layer));
  }),
);
