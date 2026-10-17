import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Freeze from "../../../scripts/history-handoff/HistoryFreeze.fixture.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as Legacy from "../legacy/LegacyV1ThreadImporter.ts";
import { hydrateLegacyHistory } from "../../../scripts/history-handoff/HistoryFreeze.ts";
import * as ProviderRuntimeRecovery from "../ProviderRuntimeRecoveryService.ts";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  EventId,
  ThreadId,
  ScheduledTaskId,
  ProviderInstanceId,
  RunId,
} from "@t3tools/contracts";
import * as Orchestrator from "../Orchestrator.ts";
import {
  createThread,
  detach,
  fixture,
  makeProvider,
  message,
  oldText,
  replyText,
  send,
  threadId,
  selection,
  seedRunless,
  settle,
} from "./DetachedHistoryContinuation.fixture.ts";

vi.mock("../../checkpointing/CheckpointStore.ts", async (load) => {
  const module = await load<typeof import("../../checkpointing/CheckpointStore.ts")>();
  return {
    ...module,
    layer: Layer.mock(module.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  };
});

it.effect("retains visible text whose historical run status is unavailable", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      yield* seedRunless();
      const before = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            type: "turn-item.updated",
            id: EventId.make("unavailable-source-run"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...before.turnItems[0]!, runId: RunId.make("historical-unavailable") },
          },
        ],
      });
      yield* send(message("Continue retained text.", "continue"));
      assert.equal(provider.histories[0]?.messages[0]?.text, oldText);
      assert.isUndefined(provider.histories[0]?.messages[0]?.runStatus);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("uses canonical visibility rather than replaying rolled-back turns", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      const hidden = yield* send(message("Rolled-back decision must stay hidden.", "hidden"));
      yield* send(message(oldText, "retained"));
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            type: "run.updated",
            id: EventId.make("rollback-source"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...hidden.runs[0]!, status: "rolled_back" },
          },
        ],
      });
      yield* detach(provider);
      const before = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      assert.isFalse(before.visibleTurnItems.some(({ item }) => item.runId === hidden.runs[0]?.id));
      yield* send(message("Continue visible work.", "continue"));
      assert.isFalse(
        provider.histories[0]?.messages.some(
          (item) => item.text === "Rolled-back decision must stay hidden.",
        ),
      );
      assert.isTrue(provider.histories[0]?.messages.some((item) => item.text === oldText));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("does not confuse legacy unknown-native attempts with a new maintenance native", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      const original = yield* send(message(oldText, "original"));
      const { nativeThreadId: _oldNative, ...legacyAttempt } = original.attempts[0]!;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            type: "run-attempt.updated",
            id: EventId.make("legacy-attempt"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: legacyAttempt,
          },
          {
            type: "provider-thread.updated",
            id: EventId.make("detach-same-row"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...original.providerThreads[0]!,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              providerSessionId: null,
            },
          },
        ],
      });
      provider.histories.length = 0;
      yield* send(message("/compact", "compact"));
      assert.lengthOf(provider.histories, 0);
      yield* send(message("First ordinary message on replacement.", "first"));
      assert.lengthOf(provider.histories, 1);
      assert.isTrue(provider.histories[0]?.messages.some((item) => item.text === oldText));
      yield* send(message("Next ordinary message.", "next"));
      assert.lengthOf(provider.histories, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("continues detached V2 history once through ordinary Send", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      yield* send(message(oldText, "original"));
      yield* detach(provider);
      const readable = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
      assert.isTrue(
        readable.visibleTurnItems.some(
          ({ item }) => item.type === "assistant_message" && item.text === replyText,
        ),
      );
      assert.deepEqual(provider.calls, []);
      const first = yield* send(message("Continue from that decision.", "first"));
      assert.lengthOf(provider.histories, 1);
      assert.deepEqual(
        provider.histories[0]?.messages.map((item) => item.text),
        [oldText, replyText],
      );
      assert.equal(provider.turns[0]?.message.text, "Continue from that decision.");
      assert.equal(first.contextHandoffs[0]?.targetRunId, first.runs.at(-1)?.id);
      yield* send(message("Now validate it.", "second"));
      assert.lengthOf(provider.histories, 1);
      assert.equal(provider.calls.filter((call) => call === "ensure").length, 1);
      assert.equal(provider.turns[1]?.message.text, "Now validate it.");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["runless", "deferred", "archive", "inline", "empty", "maintenance"] as const)(
  "continues through the %s route",
  (route) =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread();
        if (route !== "empty") yield* seedRunless();
        if (route === "archive") {
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive"),
            threadId,
          });
          yield* orchestrator.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make("reopen"),
            threadId,
          });
          yield* worker.drain();
          assert.deepEqual(provider.calls, []);
        }
        if (route === "maintenance") {
          yield* send(message("/compact", "maintenance"));
          assert.lengthOf(provider.histories, 0);
        }
        provider.controls.inline = route === "inline";
        const command = message("Current message only once.", "first");
        if (route === "deferred") {
          yield* orchestrator.dispatch({ ...command, dispatchMode: { type: "defer_start" } });
          assert.equal(yield* worker.drain(), 0);
          assert.deepEqual(provider.calls, []);
          const prepared = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          assert.isNotNull(prepared.contextHandoffId);
          yield* orchestrator.dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make("release"),
            threadId,
            runId: prepared.id,
          });
          yield* settle(prepared.id);
        } else {
          yield* send(command);
        }
        assert.lengthOf(provider.histories, route === "empty" ? 0 : 1);
        if (route !== "empty") {
          assert.isTrue(provider.histories[0]?.messages.some((entry) => entry.text === oldText));
          assert.isFalse(
            provider.histories[0]?.messages.some((entry) => entry.text === command.text),
          );
        }
        if (route === "inline") assert.include(provider.turns[0]!.message.text, oldText);
        const afterFirst = yield* orchestrator.getThreadProjection(threadId);
        yield* send(message("Second message.", "second"));
        const afterSecond = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(afterSecond.contextHandoffs.length, afterFirst.contextHandoffs.length);
        assert.lengthOf(provider.histories, route === "empty" ? 0 : 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["stop", "process-loss", "settled-process-loss"] as const)(
  "retains the first obligation after %s",
  (boundary) =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* createThread();
        yield* seedRunless();
        yield* orchestrator.dispatch(message("Interrupted first message.", "first"));
        const before = yield* orchestrator.getThreadProjection(threadId);
        const initial = before.runs[0]!;
        assert.lengthOf(before.contextHandoffs, 1);
        if (boundary === "stop") {
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: initial.id,
          });
        } else {
          if (boundary === "settled-process-loss") {
            provider.controls.hold = true;
            yield* worker.drain();
            provider.controls.hold = false;
            assert.lengthOf(provider.histories, 1);
          }
          const recovery = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
            .recover;
          assert.equal(recovery.terminalizedRuns, 1);
          if (boundary === "process-loss") assert.equal(recovery.retiredEffects, 1);
        }
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(recovered.runs[0]?.status, boundary === "stop" ? "interrupted" : "cancelled");
        yield* worker.drain();
        for (let index = 0; index < 2; index++) {
          assert.isTrue(
            (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
          );
        }
        yield* send(message("Explicit later retry.", "retry"));
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[0]?.status, recovered.runs[0]?.status);
        assert.equal(
          after.runs.at(-1)?.contextHandoffId,
          boundary === "settled-process-loss" ? null : initial.contextHandoffId,
        );
        assert.lengthOf(
          after.contextHandoffs.filter((handoff) => handoff.strategy === "full_thread_summary"),
          1,
        );
        assert.lengthOf(provider.histories, 1);
        yield* send(message("Ordinary following message.", "following"));
        assert.lengthOf(provider.histories, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "replays the receipt and promotes a competing explicit send without repeating history",
  () =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        yield* createThread();
        yield* seedRunless();
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const first = message("First accepted message.", "first");
        yield* Effect.all(
          [
            orchestrator.dispatch(first),
            orchestrator.dispatch(message("Competing queued message.", "second")),
          ],
          { concurrency: "unbounded" },
        );
        yield* orchestrator.dispatch(first);
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.lengthOf(before.runs, 2);
        assert.lengthOf(before.contextHandoffs, 1);
        assert.equal(before.runs[1]?.status, "queued");
        yield* settle(before.runs[0]!.id);
        yield* settle(before.runs[1]!.id);
        assert.lengthOf(provider.histories, 1);
        assert.deepEqual(
          provider.histories[0]?.messages.map((item) => item.text),
          [oldText],
        );
        assert.deepEqual(
          provider.turns.map((turn) => turn.message.text),
          before.runs.map(
            (run) => before.messages.find((entry) => entry.id === run.userMessageId)?.text,
          ),
        );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["agent", "scheduled", "sender", "maintenance"] as const)(
  "does not create initial context from %s input",
  (source) =>
    Effect.gen(function* () {
      const provider = makeProvider();
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        yield* createThread();
        yield* seedRunless();
        const command = message(
          source === "maintenance" ? "/compact" : "Automatic input",
          "automatic",
        );
        yield* (yield* Orchestrator.OrchestratorV2).dispatch({
          ...command,
          ...(source === "agent" ? { createdBy: "agent", creationSource: "mcp" } : {}),
          ...(source === "scheduled" ? { scheduledTaskId: ScheduledTaskId.make("task:auto") } : {}),
          ...(source === "sender" ? { senderThreadId: ThreadId.make("sender") } : {}),
        });
        const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
          threadId,
        );
        assert.lengthOf(projection.contextHandoffs, 0);
        assert.deepEqual(provider.calls, []);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([false, true])(
  "retains inherited fork history with independent merge-back %s",
  (mergeBack) =>
    Effect.gen(function* () {
      const provider = makeProvider();
      provider.controls.capabilities = {
        ...provider.controls.capabilities,
        threads: {
          ...provider.controls.capabilities.threads,
          canForkThread: false,
          canForkFromTurn: false,
        },
      };
      const layer = yield* fixture(provider);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* createThread();
        const source = yield* send(message(oldText, "source"));
        const forkId = ThreadId.make("thread:real-fork");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork"),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "latest_stable" },
          title: "Real fork",
        });
        const fork = yield* send(
          message("Independent fork decision is amber.", "fork-first", forkId),
        );
        assert.equal(fork.contextTransfers[0]?.status, "consumed");
        const inheritedIds = source.turnItems
          .filter((item) => item.type === "user_message" || item.type === "assistant_message")
          .map((item) => item.id);
        assert.isFalse(fork.turnItems.some((item) => inheritedIds.includes(item.id)));
        assert.deepEqual(
          fork.visibleTurnItems
            .filter(
              (row) =>
                row.visibility === "inherited" &&
                (row.item.type === "user_message" || row.item.type === "assistant_message"),
            )
            .map((row) => row.item.id),
          inheritedIds,
        );
        const target = mergeBack ? threadId : forkId;
        if (mergeBack)
          yield* orchestrator.dispatch({
            type: "thread.merge_back",
            commandId: CommandId.make("merge"),
            createdBy: "user",
            creationSource: "web",
            sourceThreadId: forkId,
            targetThreadId: threadId,
            sourcePoint: { type: "latest_stable" },
          });
        yield* detach(provider, target);
        const before = yield* orchestrator.getThreadProjection(target);
        const after = yield* send(message("Continue with all decisions.", "continue", target));
        const history = provider.histories[0]!;
        assert.isTrue(history.messages.some((item) => item.text === oldText));
        assert.isTrue(
          history.messages.some((item) => item.text === "Independent fork decision is amber."),
        );
        if (!mergeBack) {
          assert.deepEqual(
            history.messages.slice(0, inheritedIds.length).map((item) => item.itemId),
            inheritedIds,
          );
          assert.isTrue(
            history.messages
              .slice(0, inheritedIds.length)
              .every((item) => item.runStatus === "completed"),
          );
        } else {
          assert.isTrue(
            after.contextHandoffs.some((handoff) => handoff.strategy === "fork_delta_summary"),
          );
          assert.isTrue(
            after.contextHandoffs.some(
              (handoff) =>
                handoff.strategy === "full_thread_summary" &&
                handoff.targetRunId === after.runs.at(-1)?.id,
            ),
          );
        }
        assert.isAtLeast(after.contextHandoffs.length, before.contextHandoffs.length + 1);
        yield* send(message("Another ordinary turn.", "following", target));
        assert.lengthOf(provider.histories, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("switches to a detached old provider with full mixed-provider context", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const peer = makeProvider(ProviderInstanceId.make("other-codex"));
    const layer = yield* fixture(provider, undefined, [peer]);
    yield* Effect.gen(function* () {
      yield* createThread();
      const first = yield* send(message(oldText, "first"));
      const switched = yield* send({
        ...message("The other provider decided amber.", "other"),
        modelSelection: { ...selection, instanceId: peer.adapter.instanceId },
      });
      const oldProvider = first.providerThreads[0]!;
      yield* (yield* EventSink.EventSinkV2).write({
        events: [
          {
            type: "provider-thread.updated",
            id: EventId.make("detach-old-provider"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...oldProvider,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              providerSessionId: null,
              status: "not_loaded",
            },
          },
          {
            type: "thread.metadata-updated",
            id: EventId.make("retain-current-provider"),
            threadId,
            occurredAt: yield* DateTime.now,
            payload: switched.thread,
          },
        ],
      });
      provider.histories.length = 0;
      yield* send({
        ...message("Switch back with all decisions.", "return"),
        modelSelection: selection,
      });
      assert.lengthOf(provider.histories, 1);
      assert.deepEqual(
        provider.histories[0]?.messages.map((item) => item.text),
        [oldText, replyText, "The other provider decided amber.", replyText],
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("bounds long Unicode history and retains current attachments", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      yield* createThread();
      yield* seedRunless("🦉é".repeat(40_000));
      const attachments = [
        {
          type: "file" as const,
          id: "current-file",
          name: "current.txt",
          sizeBytes: 12,
          mimeType: "text/plain",
        },
      ];
      const after = yield* send({ ...message("Use this current file.", "current"), attachments });
      assert.deepEqual(provider.turns[0]?.message.attachments, attachments);
      assert.lengthOf(after.contextHandoffs, 1);
      assert.isAbove(after.contextHandoffs[0]?.history?.omittedItems ?? 0, 0);
      assert.isBelow(
        new TextEncoder().encode(JSON.stringify(provider.histories[0])).length,
        64_000,
      );
      assert.notInclude(JSON.stringify(provider.histories[0]), "\\ufffd");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("continues the committed freeze fixture through ordinary Send", () =>
  Effect.gen(function* () {
    const seeded = yield* Freeze.seed();
    const sourceSequence = yield* (yield* EventStore.EventStoreV2).latestApplicationSequence;
    yield* Freeze.freeze({
      operationId: "detached-proof",
      expectedApplicationSequence: sourceSequence,
      frozenAt: Freeze.frozenAt,
    });
    const provider = makeProvider();
    const sql = yield* SqlClient.SqlClient;
    const layer = yield* fixture(provider, Layer.succeed(SqlClient.SqlClient, sql));
    yield* Effect.gen(function* () {
      const before = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        seeded.parent.id,
      );
      assert.isTrue(
        before.visibleTurnItems.some(
          ({ item }) =>
            item.type === "assistant_message" &&
            item.text === "Existing settled result survives exactly",
        ),
      );
      assert.deepEqual(provider.calls, []);
      const recovery = yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService)
        .recover;
      assert.equal(recovery.terminalizedRuns, 0);
      assert.equal(yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain(), 0);
      assert.deepEqual(provider.calls, []);
      const unavailable = yield* (yield* Orchestrator.OrchestratorV2)
        .dispatch(
          message(
            "Use the unavailable historical selection.",
            "missing-selection",
            seeded.parent.id,
          ),
        )
        .pipe(Effect.exit);
      assert.equal(unavailable._tag, "Failure");
      const unchanged = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(
        seeded.parent.id,
      );
      assert.deepEqual(unchanged.thread.modelSelection, before.thread.modelSelection);
      assert.lengthOf(unchanged.runs, before.runs.length);
      assert.deepEqual(provider.calls, []);
      yield* send({
        ...message("Continue my retained work.", "freeze-first", seeded.parent.id),
        modelSelection: selection,
      });
      assert.lengthOf(provider.histories, 1);
      assert.isTrue(
        provider.histories[0]?.messages.some(
          (item) => item.text === "Existing settled result survives exactly",
        ),
      );
      yield* send(message("Next step.", "freeze-second", seeded.parent.id));
      assert.lengthOf(provider.histories, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Freeze.layerFixture)),
);

it.effect("promotes the first manual message queued behind maintenance", () =>
  Effect.gen(function* () {
    const provider = makeProvider();
    const layer = yield* fixture(provider);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* createThread();
      yield* seedRunless();
      provider.controls.hold = true;
      yield* orchestrator.dispatch(message("/compact", "compact"));
      yield* worker.drain();
      assert.lengthOf(provider.histories, 0);
      yield* orchestrator.dispatch(message("First ordinary queued intent.", "first"));
      const queued = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(queued.runs[1]?.status, "queued");
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("stop-compact"),
        threadId,
        runId: queued.runs[0]!.id,
      });
      provider.controls.hold = false;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-queue"),
        threadId,
      });
      const after = yield* settle(queued.runs[1]!.id);
      assert.lengthOf(provider.histories, 1);
      assert.isTrue(provider.histories[0]?.messages.some((item) => item.text === oldText));
      assert.isFalse(
        provider.histories[0]?.messages.some(
          (item) => item.text === "First ordinary queued intent.",
        ),
      );
      assert.isNotNull(after.runs[1]?.contextHandoffId);
      yield* send(message("Next ordinary turn.", "next"));
      assert.lengthOf(provider.histories, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("preserves the real V1 import first-turn handoff", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const id = ThreadId.make("legacy-continuation");
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('legacy-project','Legacy','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES (${id},'legacy-project','Legacy discussion','{"instanceId":"codex","model":"gpt-5.4"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('legacy-message',${id},'assistant','The genuine legacy answer.','[]',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    assert.equal(yield* (yield* Legacy.LegacyV1ThreadImporter).pendingThreadCount, 1);
    yield* hydrateLegacyHistory();
    const provider = makeProvider();
    const layer = yield* fixture(provider, Layer.succeed(SqlClient.SqlClient, sql));
    yield* Effect.gen(function* () {
      const first = yield* send(message("Continue legacy work.", "legacy-first", id));
      assert.equal(first.thread.historyOrigin, "v1_import");
      assert.deepEqual(
        first.contextHandoffs.map((handoff) => handoff.strategy),
        ["manual_context"],
      );
      assert.include(JSON.stringify(provider.histories), "The genuine legacy answer.");
      yield* send(message("Next turn.", "legacy-next", id));
      assert.lengthOf(provider.histories, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Freeze.layerFixture)),
);
