import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  ContextTransferId,
  EventId,
  ProviderInstanceId,
  ProviderThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../EventSink.ts";
import { readNativeContext } from "../ContextHandoffDelivery.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Worker from "../EffectWorker.ts";
import * as Recovery from "../ProviderRuntimeRecoveryService.ts";
import * as Maintenance from "../ProjectionMaintenance.ts";
import * as F from "./DetachedHistoryContinuation.fixture.ts";
import { peerId, providers, updateRow } from "./NativeContext.fixture.ts";

vi.mock("../../checkpointing/CheckpointStore.ts", async (load) => {
  const module = await load<typeof import("../../checkpointing/CheckpointStore.ts")>();
  return {
    ...module,
    layer: Layer.mock(module.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  };
});

const pendingAlias = Effect.fnUntraced(function* (
  provider: ReturnType<typeof F.makeProvider>,
  inline = false,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const worker = yield* Worker.OrchestrationEffectWorkerV2;
  yield* F.createThread();
  yield* F.seedRunless();
  const pending = yield* Deferred.make<void>();
  const pause = Deferred.succeed(pending, undefined).pipe(Effect.andThen(Effect.never));
  provider.controls.inline = inline;
  if (inline) provider.controls.beforeStart = pause;
  else provider.controls.beforeInject = pause;
  yield* orchestrator.dispatch(F.message("First accepted intent.", "first"));
  yield* orchestrator.dispatch({
    ...F.message("Queued compatible intent.", "queued"),
    modelSelection: { ...F.selection, instanceId: peerId },
  });
  const queued = (yield* orchestrator.getThreadProjection(F.threadId)).runs.at(-1)!;
  assert.equal(queued.status, "queued");
  const running = yield* worker.drain().pipe(Effect.forkScoped);
  yield* Deferred.await(pending);
  const initial = yield* orchestrator.getThreadProjection(F.threadId);
  assert.equal(initial.contextHandoffs[0]?.delivery?.status, "pending");
  yield* Fiber.interrupt(running);
  yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
  provider.controls.beforeInject = Effect.void;
  provider.controls.beforeStart = Effect.void;
  const native = initial.providerThreads.find(
    (row) => row.id === initial.runs[0]!.providerThreadId,
  )!.nativeThreadRef!.nativeId!;
  provider.forbiddenNativeIds.add(native);
  return { initial, queued, native };
});

it.effect.each([
  "allocated",
  "retired",
  "before-injection",
  "after-injection",
  "before-inline",
  "inline-source",
  "settled",
] as const)("preserves the cross-row carrier through real process loss at %s", (boundary) =>
  Effect.gen(function* () {
    const { provider, peer, registry, keys } = providers();
    const layer = yield* F.fixture(provider, undefined, [], registry);
    yield* Effect.gen(function* () {
      const { initial, queued, native } = yield* pendingAlias(
        provider,
        boundary === "inline-source",
      );
      peer.forbiddenNativeIds.add(native);
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const milestone = yield* Deferred.make<void>();
      const pause = Deferred.succeed(milestone, undefined).pipe(Effect.andThen(Effect.never));
      peer.controls.inline = boundary === "before-inline";
      if (boundary === "before-injection" || boundary === "inline-source")
        peer.controls.beforeInject = pause;
      if (boundary === "before-inline" || boundary === "settled") peer.controls.beforeStart = pause;
      const guarded = sink.writeIfRunCurrent;
      const guardedSpy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) => {
        if (input.expectedRootProviderThreads === undefined) return guarded(input);
        if (boundary === "allocated") return pause.pipe(Effect.andThen(guarded(input)));
        return boundary === "retired"
          ? guarded(input).pipe(Effect.tap((result) => (result.committed ? pause : Effect.void)))
          : guarded(input);
      });
      const write = sink.write;
      const writeSpy = vi
        .spyOn(sink, "write")
        .mockImplementation((input) =>
          boundary === "after-injection" &&
          input.events.some(
            (event) =>
              event.type === "context-handoff.updated" &&
              event.payload.delivery?.status === "injected",
          )
            ? pause
            : write(input),
        );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          guardedSpy.mockRestore();
          writeSpy.mockRestore();
        }),
      );
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-queued"),
        threadId: F.threadId,
      });
      const promoted = yield* orchestrator.getThreadProjection(F.threadId);
      assert.equal(
        promoted.runs.find((run) => run.id === queued.id)?.contextHandoffId,
        initial.contextHandoffs[0]!.id,
      );
      const executing = yield* worker.drain().pipe(Effect.forkScoped);
      yield* Deferred.await(milestone);
      const crashed = yield* orchestrator.getThreadProjection(F.threadId);
      const retired = crashed.providerThreads.find(
        (row) =>
          row.id ===
          initial.providerThreads.find((row) => row.id === initial.runs[0]!.providerThreadId)!.id,
      )!;
      const target = crashed.providerThreads.find((row) => row.id === queued.providerThreadId)!;
      if (boundary === "allocated") assert.equal(retired.nativeThreadRef?.nativeId, native);
      else {
        assert.isNull(retired.nativeThreadRef);
        assert.isNull(retired.providerSessionId);
        assert.isNull(retired.nativeConversationHeadRef);
        assert.isNull(retired.nativeMetadata);
        assert.notEqual(target.nativeThreadRef?.nativeId, native);
        assert.equal(crashed.thread.activeProviderThreadId, target.id);
      }
      yield* Fiber.interrupt(executing);
      guardedSpy.mockRestore();
      writeSpy.mockRestore();
      peer.controls.beforeStart = Effect.void;
      peer.controls.beforeInject = Effect.void;
      yield* TestClock.adjust(1);
      yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      assert.equal(
        (yield* orchestrator.getThreadProjection(F.threadId)).runs.find(
          (run) => run.id === queued.id,
        )?.status,
        "cancelled",
      );
      for (let pass = 0; pass < 2; pass++)
        assert.isTrue((yield* (yield* Maintenance.ProjectionMaintenanceV2).rebuild).valid);
      if (boundary === "settled") keys.set(F.selection.instanceId, "codex:account:changed-owner");
      const count = peer.histories.length;
      yield* orchestrator.dispatch(F.message("Explicit retry after process loss.", "retry"));
      const retry = yield* orchestrator.getThreadProjection(F.threadId);
      const after = yield* F.settle(retry.runs.at(-1)!.id);
      assert.equal(after.runs.find((run) => run.id === initial.runs[0]!.id)?.status, "cancelled");
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "cancelled");
      assert.isNull(after.providerThreads.find((row) => row.id === retired.id)?.nativeThreadRef);
      assert.notInclude(peer.calls, "fork");
      if (boundary === "settled") assert.lengthOf(peer.histories, count);
      else
        assert.equal(
          peer.histories.at(-1)?.messages.filter((entry) => entry.text === F.oldText).length,
          1,
        );
      const settledCount = peer.histories.length;
      yield* F.send(F.message("Next normal turn.", "next"));
      assert.lengthOf(peer.histories, settledCount);
      provider.controls.nativePrefix = peerId;
      yield* F.send({
        ...F.message("Return to the retired account.", "return"),
        modelSelection: F.selection,
      });
      assert.notEqual(provider.turns.at(-1)?.providerThread.nativeThreadRef?.nativeId, native);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["insert", "change", "remove"] as const)(
  "settles a rejected replacement and permits later Send when a root alias is concurrently %s",
  (race) =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        const { initial, queued, native } = yield* pendingAlias(provider);
        peer.forbiddenNativeIds.add(native);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-race"),
          threadId: F.threadId,
        });
        const guarded = sink.writeIfRunCurrent;
        let raced = false;
        const spy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) =>
          Effect.gen(function* () {
            if (input.expectedRootProviderThreads !== undefined && !raced) {
              raced = true;
              const alias = input.expectedRootProviderThreads.find(
                (row) =>
                  row.id ===
                  initial.providerThreads.find(
                    (row) => row.id === initial.runs[0]!.providerThreadId,
                  )!.id,
              )!;
              yield* updateRow(
                {
                  ...alias,
                  ...(race === "insert" ? { id: ProviderThreadId.make("concurrent-alias") } : {}),
                  ...(race === "change"
                    ? {
                        nativeMetadata: {
                          ...alias.nativeMetadata,
                          title: "Concurrent metadata change",
                        },
                      }
                    : {}),
                  ...(race === "remove" ? { appThreadId: null } : {}),
                },
                `race-${race}`,
              ).pipe(Effect.provideService(EventSink.EventSinkV2, sink));
            }
            return yield* guarded(input);
          }),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* worker.drain();
        spy.mockRestore();
        assert.isTrue(raced);
        const after = yield* orchestrator.getThreadProjection(F.threadId);
        assert.equal(after.contextHandoffs[0]?.delivery?.nativeThreadId, native);
        assert.equal(after.contextHandoffs[0]?.delivery?.status, "pending");
        assert.lengthOf(peer.histories, 0);
        assert.lengthOf(peer.turns, 0);
        assert.deepEqual(peer.calls, ["open", "ensure"]);
        const sql = yield* SqlClient.SqlClient;
        const starts = yield* sql<{ status: string; attempt_count: number }>`
          SELECT status, attempt_count FROM orchestration_v2_effect_outbox
          WHERE thread_id = ${F.threadId}
            AND json_extract(payload_json, '$.type') = 'provider-turn.start'
            AND json_extract(payload_json, '$.runId') = ${queued.id}
        `;
        assert.deepEqual(starts, [{ status: "succeeded", attempt_count: 1 }]);
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "failed");
        assert.equal(
          after.attempts.find((attempt) => attempt.id === queued.activeAttemptId)?.status,
          "failed",
        );
        assert.equal(after.nodes.find((node) => node.id === queued.rootNodeId)?.status, "failed");
        assert.isTrue(
          after.turnItems.some((item) => item.runId === queued.id && item.type === "error"),
        );
        assert.equal(yield* worker.drain(), 0);
        yield* orchestrator.dispatch(F.message("Later explicit input.", "later"));
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-after-rejected-replacement"),
          threadId: F.threadId,
        });
        const later = (yield* orchestrator.getThreadProjection(F.threadId)).runs.at(-1)!;
        yield* worker.drain();
        assert.notInclude(peer.calls, "resume");
        assert.lengthOf(peer.turns, 1);
        const completed = yield* F.settle(later.id);
        assert.equal(completed.runs.find((run) => run.id === queued.id)?.status, "failed");
        assert.lengthOf(peer.turns, 1);
        assert.equal(peer.turns[0]?.message.text, "Later explicit input.");
        assert.notEqual(peer.turns[0]?.providerThread.nativeThreadRef?.nativeId, native);
        assert.equal(
          peer.histories
            .flatMap((history) => history.messages)
            .filter((entry) => entry.text === F.oldText).length,
          1,
        );
        const deliveries = peer.histories.length;
        yield* F.send(F.message("Following ordinary turn.", "following"));
        assert.lengthOf(peer.histories, deliveries);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(
  (["pending", "injected"] as const).flatMap((delivery) =>
    (["linked", "incompatible", "unlinked", "partial", "transfer"] as const).map((boundary) => ({
      delivery,
      boundary,
    })),
  ),
)("scopes an orphaned $delivery receipt through a $boundary carrier", ({ delivery, boundary }) =>
  Effect.gen(function* () {
    const foreign = F.makeProvider(ProviderInstanceId.make("codex_synthetic_foreign"));
    const { provider, peer, registry, keys } = providers([foreign]);
    keys.set(foreign.adapter.instanceId, "codex:account:other");
    const layer = yield* F.fixture(provider, undefined, [], registry);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* Worker.OrchestrationEffectWorkerV2;
      const sink = yield* EventSink.EventSinkV2;
      const { native } = yield* pendingAlias(provider);
      peer.forbiddenNativeIds.add(native);
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-orphan-carrier"),
        threadId: F.threadId,
      });
      if (delivery === "injected") {
        const milestone = yield* Deferred.make<void>();
        peer.controls.beforeStart = Deferred.succeed(milestone, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const running = yield* worker.drain().pipe(Effect.forkScoped);
        yield* Deferred.await(milestone);
        yield* Fiber.interrupt(running);
        yield* TestClock.adjust(1);
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
      }
      const before = yield* orchestrator.getThreadProjection(F.threadId);
      const origin = before.runs[0]!;
      const carrier = before.runs.at(-1)!;
      const handoff = before.contextHandoffs[0]!;
      assert.equal(handoff.delivery?.status, delivery);
      assert.equal(carrier.contextHandoffId, handoff.id);
      const source = before.providerThreads.find((row) => row.id === origin.providerThreadId)!;
      yield* updateRow({ ...source, appThreadId: null }, "remove-origin-row");
      const now = yield* DateTime.now;
      if (boundary === "unlinked") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("unlink-carrier"),
              type: "run.updated",
              threadId: F.threadId,
              runId: carrier.id,
              occurredAt: now,
              payload: { ...carrier, contextHandoffId: null },
            },
          ],
        });
      }
      if (boundary === "partial" || boundary === "transfer") {
        yield* sink.write({
          events: [
            {
              id: EventId.make("external-or-partial-receipt"),
              type: "context-handoff.updated",
              threadId: F.threadId,
              runId: origin.id,
              providerInstanceId: peerId,
              occurredAt: now,
              payload: {
                ...handoff,
                ...(boundary === "partial"
                  ? { strategy: "fork_delta_summary" as const }
                  : { transferId: ContextTransferId.make("external-transfer") }),
              },
            },
          ],
        });
      }
      const target = before.providerThreads.find((row) => row.id === carrier.providerThreadId)!;
      assert.notEqual(target.id, source.id);
      yield* updateRow(
        {
          ...target,
          providerInstanceId:
            boundary === "incompatible" ? foreign.adapter.instanceId : F.selection.instanceId,
        },
        "change-target-account",
      );
      const projection = yield* orchestrator.getThreadProjection(F.threadId);
      const run = projection.runs.find((candidate) => candidate.id === carrier.id)!;
      const providerThread = projection.providerThreads.find(
        (row) => row.id === run.providerThreadId,
      )!;
      const initiation = projection.messages.find((message) => message.id === run.userMessageId)!;
      const context = yield* readNativeContext({ projection, run, providerThread, initiation });
      assert.equal(
        context.proof,
        boundary === "linked"
          ? delivery === "pending"
            ? "replace"
            : "established"
          : "unestablished",
      );
      assert.deepEqual(
        context.settledHandoffs.map((item) => item.id),
        boundary === "linked" && delivery === "injected" ? [handoff.id] : [],
      );
      assert.equal(projection.contextHandoffs[0]?.delivery?.status, delivery);
      assert.lengthOf(peer.turns, 0);
      assert.notInclude(peer.calls, "resume");
      assert.lengthOf(peer.histories, delivery === "injected" ? 1 : 0);
      assert.lengthOf(foreign.calls, 0);
    }).pipe(Effect.provide(Layer.merge(layer, registry)));
  }),
);

it.effect.each(["replacement", "failure-settlement"] as const)(
  "preserves Stop that wins before the %s guard",
  (boundary) =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        const { initial, queued, native } = yield* pendingAlias(provider);
        peer.forbiddenNativeIds.add(native);
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* Worker.OrchestrationEffectWorkerV2;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume-stop-race"),
          threadId: F.threadId,
        });
        const guarded = sink.writeIfRunCurrent;
        let stopped = false;
        let rejectedSettlement = false;
        const spy = vi.spyOn(sink, "writeIfRunCurrent").mockImplementation((input) =>
          Effect.gen(function* () {
            const replacement = input.expectedRootProviderThreads !== undefined;
            const failure = input.events.some(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            if (replacement && boundary === "failure-settlement") {
              const alias = initial.providerThreads.find(
                (row) => row.id === initial.runs[0]!.providerThreadId,
              )!;
              yield* updateRow(
                {
                  ...alias,
                  nativeMetadata: { ...alias.nativeMetadata, title: "Concurrent title" },
                },
                "before-stop",
              ).pipe(Effect.provideService(EventSink.EventSinkV2, sink));
            }
            if ((replacement && boundary === "replacement") || failure) {
              stopped = true;
              yield* orchestrator
                .dispatch({
                  type: "run.interrupt",
                  commandId: CommandId.make("stop-during-replacement"),
                  threadId: F.threadId,
                  runId: queued.id,
                })
                .pipe(Effect.orDie);
            }
            const result = yield* guarded(input);
            if (failure) rejectedSettlement = !result.committed;
            return result;
          }).pipe(Effect.uninterruptible),
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => spy.mockRestore()));
        yield* worker.drain();
        spy.mockRestore();
        const after = yield* orchestrator.getThreadProjection(F.threadId);
        assert.isTrue(stopped);
        assert.equal(rejectedSettlement, boundary === "failure-settlement");
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "interrupted");
        assert.equal(
          after.attempts.find((attempt) => attempt.id === queued.activeAttemptId)?.status,
          "interrupted",
        );
        assert.isFalse(
          after.turnItems.some((item) => item.runId === queued.id && item.type === "error"),
        );
        assert.equal(after.contextHandoffs[0]?.delivery?.nativeThreadId, native);
        assert.equal(after.contextHandoffs[0]?.delivery?.status, "pending");
        assert.deepEqual(peer.calls, ["open", "ensure"]);
        assert.lengthOf(peer.histories, 0);
        assert.lengthOf(peer.turns, 0);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  { delivery: "settled", account: "compatible" },
  { delivery: "settled", account: "incompatible" },
  { delivery: "pending", account: "compatible" },
  { delivery: "pending", account: "incompatible" },
  { delivery: "pending", account: "unavailable" },
  { delivery: "pending", account: "unavailable-detached" },
] as const)(
  "uses immutable delivery provenance after owner mutation: $delivery / $account",
  ({ delivery, account }) =>
    Effect.gen(function* () {
      const { provider, peer, registry, keys, unavailable } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.seedRunless();
        const milestone = yield* Deferred.make<void>();
        const pause = Deferred.succeed(milestone, undefined).pipe(Effect.andThen(Effect.never));
        if (delivery === "settled") provider.controls.beforeStart = pause;
        else provider.controls.beforeInject = pause;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(F.message("Original intent.", "first"));
        const running = yield* (yield* Worker.OrchestrationEffectWorkerV2)
          .drain()
          .pipe(Effect.forkScoped);
        yield* Deferred.await(milestone);
        yield* Fiber.interrupt(running);
        yield* TestClock.adjust(1);
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        const before = yield* orchestrator.getThreadProjection(F.threadId);
        assert.lengthOf(before.providerTurns, 0);
        const row = before.providerThreads[0]!;
        const native = row.nativeThreadRef!.nativeId;
        yield* updateRow(
          {
            ...row,
            providerInstanceId: peerId,
            providerSessionId: null,
            ...(account === "unavailable-detached" ? { nativeThreadRef: null } : {}),
          },
          "changed-owner",
        );
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              type: "thread.metadata-updated",
              id: EventId.make("changed-selection"),
              threadId: F.threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...before.thread,
                providerInstanceId: peerId,
                modelSelection: { ...F.selection, instanceId: peerId },
              },
            },
          ],
        });
        if (account === "incompatible") keys.set(peerId, "codex:account:independent");
        if (account === "unavailable" || account === "unavailable-detached")
          unavailable.add(F.selection.instanceId);
        if (account === "unavailable") {
          const result = yield* orchestrator
            .dispatch(F.message("Refuse uncertain account.", "next"))
            .pipe(Effect.exit);
          assert.equal(result._tag, "Failure");
          assert.lengthOf((yield* orchestrator.getThreadProjection(F.threadId)).runs, 1);
          assert.deepEqual(peer.calls, []);
          return;
        }
        const after = yield* F.send(F.message("Continue after owner change.", "next"));
        const target = after.providerThreads.find(
          (candidate) => candidate.id === after.runs.at(-1)?.providerThreadId,
        )!;
        if (
          (account === "compatible" && delivery === "pending") ||
          account === "unavailable-detached"
        ) {
          assert.notEqual(target.nativeThreadRef?.nativeId, native);
          assert.notInclude(peer.calls, "resume");
        } else assert.equal(target.nativeThreadRef?.nativeId, native);
        assert.lengthOf(peer.histories, account === "compatible" && delivery === "settled" ? 0 : 1);
        if (account === "incompatible")
          assert.notEqual(after.runs.at(-1)?.contextHandoffId, before.contextHandoffs[0]!.id);
        assert.lengthOf(peer.turns, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "keeps an old alias's pending receipt when a detached target uses an unavailable account's history",
  () =>
    Effect.gen(function* () {
      const { provider, peer, registry, unavailable, keys } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.seedRunless();
        const milestone = yield* Deferred.make<void>();
        provider.controls.beforeInject = Deferred.succeed(milestone, undefined).pipe(
          Effect.andThen(Effect.never),
        );
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* orchestrator.dispatch(F.message("Accepted old account intent.", "first"));
        const running = yield* (yield* Worker.OrchestrationEffectWorkerV2)
          .drain()
          .pipe(Effect.forkScoped);
        yield* Deferred.await(milestone);
        yield* Fiber.interrupt(running);
        yield* (yield* Recovery.ProviderRuntimeRecoveryService).recover;
        const before = yield* orchestrator.getThreadProjection(F.threadId);
        const row = before.providerThreads[0]!;
        const native = row.nativeThreadRef!.nativeId!;
        yield* updateRow(
          { ...row, id: ProviderThreadId.make("surviving-old-alias"), providerSessionId: null },
          "add-surviving-alias",
        );
        yield* updateRow(
          { ...row, providerInstanceId: peerId, providerSessionId: null, nativeThreadRef: null },
          "detach-selected-target",
        );
        yield* (yield* EventSink.EventSinkV2).write({
          events: [
            {
              type: "thread.metadata-updated",
              id: EventId.make("select-detached"),
              threadId: F.threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                ...before.thread,
                activeProviderThreadId: row.id,
                providerInstanceId: peerId,
                modelSelection: { ...F.selection, instanceId: peerId },
              },
            },
          ],
        });
        keys.set(peerId, "codex:account:new");
        unavailable.add(F.selection.instanceId);
        const after = yield* F.send(
          F.message("Continue on the available detached target.", "next"),
        );
        const old = after.contextHandoffs.find(
          (handoff) => handoff.id === before.contextHandoffs[0]!.id,
        )!;
        assert.equal(old.delivery?.status, "pending");
        assert.equal(old.delivery?.nativeThreadId, native);
        assert.notEqual(after.runs.at(-1)?.contextHandoffId, old.id);
        assert.lengthOf(peer.histories, 1);
        assert.lengthOf(peer.turns, 1);
        assert.notInclude(peer.calls, "resume");
      }).pipe(Effect.provide(layer));
    }),
);
