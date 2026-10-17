import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { peerId, providers } from "./NativeContext.fixture.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as Worker from "../EffectWorker.ts";
import * as F from "./DetachedHistoryContinuation.fixture.ts";

vi.mock("../../checkpointing/CheckpointStore.ts", async (load) => {
  const module = await load<typeof import("../../checkpointing/CheckpointStore.ts")>();
  return {
    ...module,
    layer: Layer.mock(module.CheckpointStore)({ isGitRepository: () => Effect.succeed(false) }),
  };
});

it.effect("delivers retained local history after an agent consumed an external fork delta", () =>
  Effect.gen(function* () {
    const provider = F.makeProvider();
    provider.controls.capabilities = {
      ...provider.controls.capabilities,
      threads: {
        ...provider.controls.capabilities.threads,
        canForkThread: false,
        canForkFromTurn: false,
      },
    };
    const layer = yield* F.fixture(provider);
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* F.createThread();
      yield* F.send(F.message(F.oldText, "parent-original"));
      const forkId = ThreadId.make("thread:coverage-fork");
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("coverage-fork"),
        createdBy: "user",
        creationSource: "web",
        sourceThreadId: F.threadId,
        targetThreadId: forkId,
        sourcePoint: { type: "latest_stable" },
        title: "Coverage fork",
      });
      yield* F.send(F.message("Independent fork decision is amber.", "fork-first", forkId));
      yield* F.detach(provider);
      yield* orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make("coverage-merge"),
        createdBy: "user",
        creationSource: "web",
        sourceThreadId: forkId,
        targetThreadId: F.threadId,
        sourcePoint: { type: "latest_stable" },
      });
      const automatic = yield* F.send({
        ...F.message("Automatic merge acknowledgement.", "agent"),
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.deepEqual(
        automatic.contextHandoffs.map((handoff) => handoff.strategy),
        ["fork_delta_summary"],
      );
      assert.isFalse(
        provider.histories
          .flatMap((history) => history.messages)
          .some((entry) => entry.text === F.oldText),
      );
      const before = provider.histories.length;
      const after = yield* F.send(F.message("Now continue my retained discussion.", "manual"));
      assert.lengthOf(provider.histories, before + 1);
      assert.equal(
        provider.histories
          .flatMap((history) => history.messages)
          .filter((entry) => entry.text === F.oldText).length,
        1,
      );
      assert.equal(
        after.contextHandoffs.filter((handoff) => handoff.strategy === "fork_delta_summary").length,
        1,
      );
      assert.equal(
        provider.histories
          .flatMap((history) => history.messages)
          .filter((entry) => entry.text === "Independent fork decision is amber.").length,
        1,
      );
      yield* F.send(F.message("Next ordinary turn.", "next"));
      assert.lengthOf(provider.histories, before + 1);
      assert.lengthOf(provider.turns, 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["direct", "queued"] as const)(
  "does not repeat established history on a compatible %s switch",
  (route) =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* F.createThread();
        yield* F.seedRunless();
        const first = yield* F.send(F.message("First ordinary continuation.", "first"));
        const native = first.providerThreads[0]!.nativeThreadRef!.nativeId!;
        assert.lengthOf(provider.histories, 1);
        peer.controls.capabilities = {
          ...peer.controls.capabilities,
          context: { ...peer.controls.capabilities.context, supportsFullThreadHandoff: false },
        };
        if (route === "queued") {
          provider.controls.hold = true;
          yield* orchestrator.dispatch(F.message("Blocking active work.", "blocking"));
          yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
          yield* orchestrator.dispatch({
            ...F.message("Switch through queued intent.", "queued"),
            modelSelection: { ...F.selection, instanceId: peerId },
          });
          const queued = yield* orchestrator.getThreadProjection(F.threadId);
          assert.equal(queued.runs.at(-1)?.status, "queued");
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-blocking"),
            threadId: F.threadId,
            runId: queued.runs.at(-2)!.id,
          });
          provider.controls.hold = false;
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("resume-queue"),
            threadId: F.threadId,
          });
          yield* F.settle(queued.runs.at(-1)!.id);
        } else
          yield* F.send({
            ...F.message("Switch directly.", "direct"),
            modelSelection: { ...F.selection, instanceId: peerId },
          });
        const after = yield* orchestrator.getThreadProjection(F.threadId);
        assert.equal(
          after.providerThreads.find((row) => row.id === after.runs.at(-1)?.providerThreadId)
            ?.nativeThreadRef?.nativeId,
          native,
        );
        assert.isFalse(
          peer.histories
            .flatMap((history) => history.messages)
            .some((entry) => entry.text === F.oldText),
        );
        assert.lengthOf(
          after.contextHandoffs.filter((handoff) => handoff.strategy === "full_thread_summary"),
          1,
        );
        assert.lengthOf(peer.turns, 1);
        if (route === "queued")
          assert.equal(
            peer.histories
              .flatMap((history) => history.messages)
              .filter((entry) => entry.text === "Blocking active work.").length,
            1,
          );
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["same", "compatible"] as const)(
  "delivers first history after maintenance on the %s instance",
  (route) =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.seedRunless();
        const maintenance = yield* F.send(F.message("/compact", "maintenance"));
        const native = maintenance.providerThreads[0]!.nativeThreadRef!.nativeId!;
        assert.lengthOf(provider.histories, 0);
        const after = yield* F.send({
          ...F.message("First explicit continuation.", "manual"),
          ...(route === "compatible"
            ? { modelSelection: { ...F.selection, instanceId: peerId } }
            : {}),
        });
        assert.equal(
          after.providerThreads.find((row) => row.id === after.runs.at(-1)?.providerThreadId)
            ?.nativeThreadRef?.nativeId,
          native,
        );
        assert.equal(
          [...provider.histories, ...peer.histories]
            .flatMap((history) => history.messages)
            .filter((entry) => entry.text === F.oldText).length,
          1,
        );
        assert.lengthOf([...provider.turns, ...peer.turns], 2);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "continues a detached discussion without reading its unavailable historical account",
  () =>
    Effect.gen(function* () {
      const { provider, peer, registry, unavailable } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.send(F.message(F.oldText, "original"));
        yield* F.detach(provider);
        unavailable.add(F.selection.instanceId);
        const after = yield* F.send({
          ...F.message("Continue on an available account.", "available"),
          modelSelection: { ...F.selection, instanceId: peerId },
        });
        assert.lengthOf(peer.histories, 1);
        assert.include(
          peer.histories[0]!.messages.map((entry) => entry.text),
          F.oldText,
        );
        assert.equal(after.runs.at(-1)?.providerInstanceId, peerId);
        assert.notInclude(peer.calls, "resume");
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("keeps instances separate when the registry has no metadata API", () =>
  Effect.gen(function* () {
    const provider = F.makeProvider();
    const peer = F.makeProvider(peerId);
    const layer = yield* F.fixture(provider, undefined, [peer]);
    yield* Effect.gen(function* () {
      yield* F.createThread();
      yield* F.seedRunless();
      yield* F.send(F.message("First context.", "first"));
      yield* F.send({
        ...F.message("New instance.", "peer"),
        modelSelection: { ...F.selection, instanceId: peerId },
      });
      assert.lengthOf(peer.histories, 1);
      assert.notInclude(peer.calls, "resume");
      yield* F.send(F.message("Same instance again.", "again"));
      assert.lengthOf(peer.histories, 1);
      assert.lengthOf(peer.turns, 2);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "preserves consecutive queued execution identities and refuses unavailable alias scope before acceptance",
  () =>
    Effect.gen(function* () {
      const { provider, peer, registry, unavailable } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.seedRunless();
        yield* F.send(F.message("First context.", "first"));
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        provider.controls.hold = true;
        yield* orchestrator.dispatch(F.message("Blocking.", "blocking"));
        yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
        for (const id of ["queued-one", "queued-two"])
          yield* orchestrator.dispatch({
            ...F.message(id, id),
            modelSelection: { ...F.selection, instanceId: peerId },
          });
        const before = yield* orchestrator.getThreadProjection(F.threadId);
        const queued = before.runs.filter((run) => run.status === "queued");
        assert.lengthOf(queued, 2);
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop"),
          threadId: F.threadId,
          runId: before.runs.at(-3)!.id,
        });
        provider.controls.hold = false;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume"),
          threadId: F.threadId,
        });
        yield* F.settle(queued[0]!.id);
        yield* F.settle(queued[1]!.id);
        const after = yield* orchestrator.getThreadProjection(F.threadId);
        for (const prior of queued) {
          const run = after.runs.find((run) => run.id === prior.id)!;
          assert.equal(run.providerThreadId, prior.providerThreadId);
          assert.equal(run.activeAttemptId, prior.activeAttemptId);
          assert.equal(run.rootNodeId, prior.rootNodeId);
          assert.equal(
            after.nodes.find((node) => node.id === run.rootNodeId)?.checkpointScopeId,
            before.nodes.find((node) => node.id === prior.rootNodeId)?.checkpointScopeId,
          );
        }
        assert.lengthOf(
          after.contextHandoffs.filter((handoff) => handoff.strategy === "full_thread_summary"),
          1,
        );
        assert.isFalse(
          peer.histories
            .flatMap((history) => history.messages)
            .some((entry) => entry.text === F.oldText),
        );
        const calls = [...peer.calls];
        unavailable.add(F.selection.instanceId);
        const result = yield* orchestrator
          .dispatch(F.message("Refuse unknown alias account.", "unavailable"))
          .pipe(Effect.exit);
        assert.equal(result._tag, "Failure");
        assert.lengthOf(
          (yield* orchestrator.getThreadProjection(F.threadId)).runs,
          after.runs.length,
        );
        assert.deepEqual(peer.calls, calls);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "retains consumed fork ancestors and later settled turns after a late compatible resume failure",
  () =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      provider.controls.capabilities = {
        ...provider.controls.capabilities,
        threads: {
          ...provider.controls.capabilities.threads,
          canForkThread: false,
          canForkFromTurn: false,
        },
      };
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const ancestor = ThreadId.make("thread:resume-ancestor");
        yield* F.createThread(ancestor);
        yield* F.send(F.message(F.oldText, "ancestor", ancestor));
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("fork"),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: ancestor,
          targetThreadId: F.threadId,
          sourcePoint: { type: "latest_stable" },
          title: "Consumed fork",
        });
        yield* F.send(F.message("Local fork decision.", "local"));
        const laterText = "Later settled decision is teal.";
        const established = yield* F.send(F.message(laterText, "later"));
        assert.isFalse(
          established.turnItems.some(
            (item) => item.type === "user_message" && item.text === F.oldText,
          ),
        );
        assert.isTrue(
          established.contextTransfers.some(
            (transfer) => transfer.type === "fork" && transfer.status === "consumed",
          ),
        );
        const native = established.providerThreads.find(
          (row) => row.id === established.runs.at(-1)?.providerThreadId,
        )!.nativeThreadRef!.nativeId!;
        provider.controls.hold = true;
        yield* orchestrator.dispatch(F.message("Blocked active intent.", "blocking"));
        yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
        yield* orchestrator.dispatch({
          ...F.message("Queued account change.", "queued"),
          modelSelection: { ...F.selection, instanceId: peerId },
        });
        const queued = yield* orchestrator.getThreadProjection(F.threadId);
        const target = queued.runs.at(-1)!;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("stop-blocking"),
          threadId: F.threadId,
          runId: queued.runs.at(-2)!.id,
        });
        provider.controls.hold = false;
        peer.controls.failResume = true;
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make("resume"),
          threadId: F.threadId,
        });
        const accepted = yield* orchestrator.getThreadProjection(F.threadId);
        assert.isFalse(
          accepted.contextHandoffs.some(
            (handoff) =>
              handoff.targetRunId === target.id && handoff.strategy === "full_thread_summary",
          ),
        );
        const after = yield* F.settle(target.id);
        const texts = peer.histories.flatMap((history) =>
          history.messages.map((entry) => entry.text),
        );
        assert.include(texts, F.oldText);
        assert.include(texts, laterText);
        assert.isBelow(texts.indexOf(F.oldText), texts.indexOf(laterText));
        assert.notEqual(
          after.providerThreads.find((row) => row.id === target.providerThreadId)?.nativeThreadRef
            ?.nativeId,
          native,
        );
        assert.isFalse(
          after.providerThreads.some((row) => row.nativeThreadRef?.nativeId === native),
        );
        assert.lengthOf(peer.turns, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "accepts a complete replacement cut after later settled turns and uncertain external delivery",
  () =>
    Effect.gen(function* () {
      const provider = F.makeProvider();
      provider.controls.capabilities = {
        ...provider.controls.capabilities,
        threads: {
          ...provider.controls.capabilities.threads,
          canForkThread: false,
          canForkFromTurn: false,
        },
      };
      const layer = yield* F.fixture(provider);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        yield* F.createThread();
        yield* F.seedRunless();
        const first = yield* F.send(F.message("First established context.", "first"));
        const firstHandoff = first.contextHandoffs[0]!;
        const laterText = "Later settled replacement decision is turquoise.";
        yield* F.send(F.message(laterText, "later"));
        const forkId = ThreadId.make("thread:replacement-delta");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("replacement-fork"),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: F.threadId,
          targetThreadId: forkId,
          sourcePoint: { type: "latest_stable" },
          title: "Independent delta",
        });
        yield* F.send(F.message("Independent amber fork decision.", "fork", forkId));
        yield* orchestrator.dispatch({
          type: "thread.merge_back",
          commandId: CommandId.make("replacement-merge"),
          createdBy: "user",
          creationSource: "web",
          sourceThreadId: forkId,
          targetThreadId: F.threadId,
          sourcePoint: { type: "latest_stable" },
        });
        provider.controls.failInjection = true;
        yield* orchestrator.dispatch({
          ...F.message("Automatic partial delivery.", "agent"),
          createdBy: "agent",
          creationSource: "mcp",
        });
        yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
        const failed = yield* orchestrator.getThreadProjection(F.threadId);
        assert.equal(failed.runs.at(-1)?.status, "failed");
        assert.isTrue(
          failed.contextHandoffs.some(
            (handoff) =>
              handoff.strategy === "fork_delta_summary" && handoff.delivery?.status === "pending",
          ),
        );
        const native = failed.providerThreads.find(
          (row) => row.id === failed.runs.at(-1)?.providerThreadId,
        )!.nativeThreadRef!.nativeId!;
        provider.controls.failInjection = false;
        provider.forbiddenNativeIds.add(native);
        yield* orchestrator.dispatch(F.message("Replace uncertain context.", "replacement"));
        const accepted = yield* orchestrator.getThreadProjection(F.threadId);
        const run = accepted.runs.at(-1)!;
        const full = accepted.contextHandoffs.find(
          (handoff) => handoff.id === run.contextHandoffId,
        )!;
        assert.notEqual(full.id, firstHandoff.id);
        assert.equal(full.strategy, "full_thread_summary");
        assert.isNull(full.transferId);
        assert.include(
          full.history!.messages.map((entry) => entry.text),
          laterText,
        );
        yield* F.settle(run.id);
        const delivered = provider.histories.at(-1)!.messages.map((entry) => entry.text);
        assert.include(delivered, F.oldText);
        assert.include(delivered, laterText);
        assert.include(delivered, "Independent amber fork decision.");
        assert.notEqual(provider.turns.at(-1)?.providerThread.nativeThreadRef?.nativeId, native);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([true, false])(
  "handles a non-portable queued target when prior work was accepted: %s",
  (accepted) =>
    Effect.gen(function* () {
      const { provider, peer, registry } = providers();
      const layer = yield* F.fixture(provider, undefined, [], registry);
      yield* Effect.gen(function* () {
        yield* F.createThread();
        yield* F.seedRunless();
        yield* F.send(F.message("Established native context.", "first"));
        peer.controls.capabilities = {
          ...peer.controls.capabilities,
          context: { ...peer.controls.capabilities.context, canConsumeHandoffSummaries: false },
        };
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        provider.controls.hold = !accepted;
        yield* orchestrator.dispatch(F.message("Prior native work.", "blocking"));
        if (!accepted) yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
        yield* orchestrator.dispatch({
          ...F.message("Queued non-portable target.", "queued"),
          modelSelection: { ...F.selection, instanceId: peerId },
        });
        const queued = yield* orchestrator.getThreadProjection(F.threadId);
        assert.equal(queued.runs.at(-1)?.status, "queued");
        if (accepted) {
          yield* F.settle(queued.runs.at(-2)!.id);
          yield* F.settle(queued.runs.at(-1)!.id);
          assert.lengthOf(peer.turns, 1);
          assert.lengthOf(peer.histories, 0);
          assert.include(peer.calls, "resume");
        } else {
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-unaccepted"),
            threadId: F.threadId,
            runId: queued.runs.at(-2)!.id,
          });
          yield* orchestrator.dispatch({
            type: "queue.resume",
            commandId: CommandId.make("resume-unsupported"),
            threadId: F.threadId,
          });
          yield* (yield* Worker.OrchestrationEffectWorkerV2).drain();
          const refused = yield* orchestrator.getThreadProjection(F.threadId);
          assert.equal(refused.runs.at(-1)?.status, "failed");
          assert.lengthOf(refused.contextHandoffs, 1);
          assert.deepEqual(peer.calls, []);
          assert.isTrue(refused.turnItems.some((item) => item.type === "error"));
        }
      }).pipe(Effect.provide(layer));
    }),
);
