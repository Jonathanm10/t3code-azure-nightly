import { assert, it } from "@effect/vitest";
import * as NodePath from "@effect/platform-node/NodePath";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  CheckpointId,
  CheckpointScopeId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as Legacy from "../../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as CheckpointRollback from "../../src/orchestration-v2/CheckpointRollbackService.ts";
import * as CheckpointService from "../../src/orchestration-v2/CheckpointService.ts";
import * as ProviderSessionManager from "../../src/orchestration-v2/ProviderSessionManager.ts";
import * as GitWorkflowService from "../../src/git/GitWorkflowService.ts";
import * as RuntimePolicy from "../../src/orchestration-v2/RuntimePolicy.ts";
import * as ThreadCommandExecutor from "../../src/orchestration-v2/ThreadCommandExecutor.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadFork from "../../src/orchestration-v2/ThreadForkService.ts";
import {
  restartContinuationRun,
  continueRestartedRun,
} from "../../src/orchestration-v2/RestartContinuation.ts";
import * as ThreadManagementService from "../../src/orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../src/serverSettings.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../src/vcs/GitVcsDriver.ts";
import { autoPullProjects } from "../../src/serverRuntimeStartup.ts";
import { assertHistoryInert, hydrateLegacyHistory, planDelegatedResult } from "./HistoryFreeze.ts";

import {
  now,
  frozenAt,
  projectId,
  layerFixture,
  freeze,
  seed,
  replayProjects,
} from "./HistoryFreeze.fixture.ts";

const encodeProjection = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const prefix = Effect.fnUntraced(function* (through: number) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT * FROM orchestration_events WHERE sequence <= ${through} ORDER BY sequence`;
});
const snapshots = Effect.fnUntraced(function* (ids: readonly ThreadId[]) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  return yield* Effect.forEach(ids, (id) => store.getThreadProjection(id));
});
const retainedContent = (p: OrchestrationV2ThreadProjection) => ({
  thread: {
    id: p.thread.id,
    projectId: p.thread.projectId,
    title: p.thread.title,
    lineage: p.thread.lineage,
    forkedFrom: p.thread.forkedFrom,
    archivedAt: p.thread.archivedAt,
    settledOverride: p.thread.settledOverride,
    settledAt: p.thread.settledAt,
    deletedAt: p.thread.deletedAt,
  },
  runs: p.runs.map(({ id, ordinal, userMessageId }) => ({ id, ordinal, userMessageId })),
  messages: p.messages.map(({ id, text, attachments }) => ({ id, text, attachments })),
  items: p.turnItems
    .filter((item) => item.type !== "run_interrupt_request")
    .map((item) => ({
      id: item.id,
      type: item.type,
      text: "text" in item ? item.text : null,
      output: "output" in item ? item.output : null,
      prompt: "prompt" in item ? item.prompt : null,
    })),
  summaries: p.contextHandoffs.map(({ id, summaryText }) => ({ id, summaryText })),
  goals: p.providerThreads.map(({ id, goal }) => ({ id, goal })),
  checkpoints: p.checkpoints,
  checkpointScopes: p.checkpointScopes,
});

it.effect("prevents native rollback and fork consumers from addressing the original runtime", () =>
  Effect.gen(function* () {
    const fixture = yield* seed();
    const events = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const calls: string[] = [];
    const denied = (name: string) =>
      Effect.sync(() => {
        calls.push(name);
      }).pipe(Effect.andThen(Effect.die(`Denied ${name}`)));
    const consumers = Layer.mergeAll(
      CheckpointRollback.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(CheckpointService.CheckpointServiceV2, {
              restore: () => denied("vcs.restore"),
            }),
            Layer.mock(GitWorkflowService.GitWorkflowService, {
              pruneWorktrees: () => denied("vcs.prune"),
              createWorktree: () => denied("vcs.create"),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2, {
              open: () => denied("provider.open"),
            }),
            FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
            NodePath.layer,
            RuntimePolicy.layer,
            IdAllocator.layer,
            ThreadCommandExecutor.layer,
          ),
        ),
      ),
      ThreadFork.layer,
    );
    yield* Effect.gen(function* () {
      const rollback = yield* CheckpointRollback.CheckpointRollbackServiceV2;
      const fork = yield* ThreadFork.ThreadForkServiceV2;
      const request = {
        threadId: fixture.parent.id,
        providerThreadId: fixture.parentRun.providerThreadId,
        checkpointId: CheckpointId.make("checkpoint"),
        scopeId: CheckpointScopeId.make("checkpoint-scope"),
        restoreFiles: false,
      };
      yield* rollback.execute(request).pipe(Effect.exit);
      assert.deepEqual(calls, ["provider.open"]);
      calls.length = 0;
      assert.isNotNull((yield* projections.getThreadShell(fixture.parent.id))?.goal);
      yield* freeze({
        operationId: "native-denied",
        frozenAt,
        expectedApplicationSequence: yield* events.latestApplicationSequence,
      });
      const refused = yield* rollback.execute(request).pipe(Effect.flip);
      assert.equal(refused.reason, "rollback-target-invalid");
      const p = yield* projections.getThreadProjection(fixture.parent.id);
      assert.isNull((yield* projections.getThreadShell(fixture.parent.id))?.goal);
      assert.isUndefined(restartContinuationRun(p, frozenAt));
      const run = p.runs[0];
      assert.isDefined(run);
      if (run === undefined) return;
      const plan = yield* fork.plan({
        sourceProjection: p,
        sourceRun: run,
        sourceProviderThread: p.providerThreads[0],
        canonicalSourcePoint: { threadId: p.thread.id, runId: run.id },
        transferId: ContextTransferId.make("manual-fork"),
        targetThreadId: ThreadId.make("manual-fork"),
        createdBy: "user",
        creationSource: "web",
        createdAt: frozenAt,
      });
      assert.equal(
        plan.transfer.error,
        "Source provider thread does not expose a strong native thread ref.",
      );
      assert.isUndefined(plan.transfer.sourcePoint.providerThreadRef);
      assert.deepEqual(calls, []);
    }).pipe(Effect.provide(consumers));
  }).pipe(Effect.provide(layerFixture)),
);

it.effect(
  "preserves all history while freezing positive execution roots through two real rebuilds",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seed();
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const events = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const sql = yield* SqlClient.SqlClient;
      const ids = fixture.threads.map((thread) => thread.id);
      const sourceHead = yield* events.latestApplicationSequence;
      const originalEvents = yield* prefix(sourceHead);
      const before = yield* snapshots(ids);
      assert.include(yield* projections.getRecoveryThreadIds("runtime"), fixture.parent.id);
      assert.include(
        yield* projections.getRecoveryThreadIds("queued-runs"),
        ThreadId.make("queue"),
      );
      assert.include(
        yield* projections.getRecoveryThreadIds("delegated-completions"),
        fixture.parent.id,
      );
      assert.lengthOf(
        yield* projections.getLimitRecoveryCandidates({
          now: frozenAt,
          autoResume: true,
          snooze: true,
        }),
        2,
      );
      assert.equal(
        (yield* sql<{
          n: number;
        }>`SELECT COUNT(*) n FROM orchestration_v2_projection_provider_session_bindings`)[0]?.n,
        3,
      );
      assert.isTrue(before.some((p) => p.runs.some((run) => run.queueHeld)));
      assert.isTrue(
        before.some((p) =>
          p.runtimeRequests.some((request) => request.responseCapability.type === "message"),
        ),
      );
      const input = { operationId: "fixture", frozenAt, expectedApplicationSequence: sourceHead };
      const receipt = yield* freeze(input);
      assert.isAbove(receipt.agentSequence, sourceHead);
      const after = yield* snapshots(ids);
      assert.deepStrictEqual(after.map(retainedContent), before.map(retainedContent));
      const parent = yield* projections.getThreadProjection(fixture.parent.id);
      assert.equal(
        parent.subagents.find((task) => task.id === "delegated")?.result,
        "Child task ended with status cancelled.",
      );
      assert.equal(
        parent.subagents.find((task) => task.id === "delegated")?.completionDelivery?.state,
        "disposed",
      );
      const delivered = parent.subagents.find((task) => task.id === "delivered-task");
      assert.equal(delivered?.result, "Already delivered settled result");
      assert.equal(delivered?.status, "completed");
      assert.equal(delivered?.completionDelivery?.state, "delivered");
      assert.equal(parent.subagents.find((task) => task.id === "native-task")?.nativeTaskRef, null);
      assert.isTrue(
        parent.runtimeRequests.every(
          (request) =>
            request.status === "cancelled" && request.responseCapability.type === "not_resumable",
        ),
      );
      assert.isTrue(
        parent.turnItems.some(
          (item) => item.type === "secret_request" && item.secretStatus === "cancelled",
        ),
      );
      assert.isTrue(
        parent.providerThreads.every(
          (thread) => thread.goal?.status === "active" && thread.nativeThreadRef === null,
        ),
      );
      assert.isTrue(
        parent.contextHandoffs.every(
          (handoff) => handoff.status === "superseded" && handoff.delivery === undefined,
        ),
      );
      assert.deepStrictEqual(yield* prefix(sourceHead), originalEvents);
      for (let pass = 0; pass < 2; pass++) {
        assert.isTrue((yield* maintenance.rebuild).valid);
        assert.equal(encodeProjection(yield* snapshots(ids)), encodeProjection(after));
        yield* assertHistoryInert(DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"));
        assert.deepStrictEqual(yield* prefix(sourceHead), originalEvents);
      }
      const retry = yield* freeze(input);
      assert.isTrue(retry.alreadyFrozen);
      assert.equal(retry.applicationSequence, receipt.applicationSequence);
      assert.deepEqual(
        yield* sql`SELECT name FROM main.sqlite_schema WHERE name LIKE 'history_handoff%'`,
        [],
      );
      for (const autoResume of [false, true])
        for (const snooze of [false, true]) {
          assert.deepEqual(
            yield* projections.getLimitRecoveryCandidates({ now: frozenAt, autoResume, snooze }),
            [],
          );
          assert.deepEqual(
            yield* projections.getLimitRecoveryCandidates({
              now: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
              autoResume,
              snooze,
            }),
            [],
          );
        }
    }).pipe(Effect.provide(layerFixture)),
);

it.effect.each(["completed", "cancelled", "interrupted", "settled-text"] as const)(
  "preserves delegated interrupted outcome for %s through replay",
  (scenario) =>
    Effect.gen(function* () {
      const fixture = yield* seed();
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* EventStore.EventStoreV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const parent = yield* projections.getThreadProjection(fixture.parent.id);
      const root = parent.nodes[0];
      assert.isDefined(root);
      if (root === undefined) return;
      yield* sink.write({
        events: [
          {
            id: EventId.make("outcome-run"),
            threadId: fixture.child.id,
            occurredAt: now,
            type: "run.updated",
            payload: {
              ...fixture.childRun,
              status: scenario === "settled-text" ? "interrupted" : scenario,
              completedAt: now,
              restartCancelledBackgroundWork: [
                { kind: "task", label: "Original unfinished awaited task" },
              ],
            },
          },
          {
            id: EventId.make("outcome-node"),
            threadId: fixture.parent.id,
            occurredAt: now,
            type: "node.updated",
            payload: { ...root, id: fixture.task.id },
          },
        ],
      });
      if (scenario === "settled-text")
        yield* sink.write({
          events: [
            {
              id: EventId.make("outcome-text"),
              threadId: fixture.child.id,
              occurredAt: now,
              type: "message.updated",
              payload: {
                id: MessageId.make("child-settled-answer"),
                threadId: fixture.child.id,
                runId: fixture.childRun.id,
                nodeId: fixture.childRun.rootNodeId,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: "Original settled child answer",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
          ],
        });
      const input = {
        operationId: `outcome-${scenario}`,
        frozenAt,
        expectedApplicationSequence: yield* store.latestApplicationSequence,
      };
      const original = yield* prefix(input.expectedApplicationSequence);
      yield* freeze(input);
      const expectedText =
        scenario === "settled-text"
          ? "Original settled child answer"
          : "Child task ended with status interrupted.";
      const frozen = yield* snapshots([fixture.parent.id, fixture.child.id]);
      for (let pass = 0; pass < 3; pass++) {
        const p = yield* projections.getThreadProjection(fixture.parent.id);
        const task = p.subagents.find((task) => task.id === fixture.task.id);
        assert.equal(task?.status, "interrupted");
        assert.equal(task?.result, expectedText);
        assert.equal(task?.completionDelivery?.state, "disposed");
        assert.equal(p.nodes.find((node) => node.id === fixture.task.id)?.status, "interrupted");
        const item = p.turnItems.find(
          (item) => item.type === "subagent" && item.subagentId === fixture.task.id,
        );
        assert.equal(item?.status, "interrupted");
        assert.equal(item?.type === "subagent" ? item.result : null, expectedText);
        assert.equal(
          p.contextTransfers.find((transfer) => transfer.type === "subagent_result")?.status,
          "consumed",
        );
        assert.deepStrictEqual(yield* prefix(input.expectedApplicationSequence), original);
        assert.equal(
          encodeProjection(yield* snapshots([fixture.parent.id, fixture.child.id])),
          encodeProjection(frozen),
        );
        if (pass < 2) assert.isTrue((yield* maintenance.rebuild).valid);
      }
      assert.isTrue((yield* freeze(input)).alreadyFrozen);
    }).pipe(Effect.provide(layerFixture)),
);

it.effect.each([
  "partial-thread",
  "pending-thread",
  "partial-parent-result",
  "thread-index",
  "orphan-message",
  "completed-project",
  "no-op-project",
  "added-thread",
  "deleted-thread",
  "added-project",
  "deleted-project",
] as const)("refuses %s projection drift without advancing the cut", (scenario) =>
  Effect.gen(function* () {
    yield* seed();
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    if (scenario === "no-op-project")
      yield* sink.commitProjectCommand({
        commandId: CommandId.make("fixture:no-pull"),
        projectId,
        commandType: "fixture",
        acceptedAt: now,
        event: {
          eventId: EventId.make("fixture:no-pull"),
          aggregateKind: "project",
          aggregateId: projectId,
          type: "project.meta-updated",
          occurredAt: DateTime.formatIso(now),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload: { projectId, autoPull: false, updatedAt: DateTime.formatIso(now) },
        },
      });
    const input = {
      operationId: `drift-${scenario}`,
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    };
    if (scenario === "partial-thread" || scenario === "pending-thread") {
      let calls = 0;
      const failed = yield* freeze(input).pipe(
        Effect.provideService(EventSink.EventSinkV2, {
          ...sink,
          commitCommand: (command) =>
            ++calls === 3
              ? Effect.fail(
                  new EventSink.EventSinkWriteError({
                    commandId: command.commandId,
                    eventCount: command.events.length,
                  }),
                )
              : sink.commitCommand(command),
        }),
        Effect.result,
      );
      assert.equal(failed._tag, "Failure");
    } else if (scenario === "partial-parent-result") {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const failed = yield* freeze(input).pipe(
        Effect.provideService(ProjectionStore.ProjectionStoreV2, {
          ...projections,
          getRecoveryThreadIds: () => Effect.die("Synthetic interruption before final audit"),
        }),
        Effect.exit,
      );
      assert.equal(failed._tag, "Failure");
    } else yield* freeze(input);
    const head = yield* store.latestApplicationSequence;
    const events = yield* prefix(head);
    const projectsBefore = yield* sql`SELECT * FROM projection_projects ORDER BY project_id`;
    switch (scenario) {
      case "pending-thread":
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.title', 'Unexpected pending title') WHERE thread_id = 'settled'`;
        break;
      case "partial-parent-result":
        yield* sql`UPDATE orchestration_v2_projection_subagents SET payload_json = json_set(payload_json, '$.result', 'Unexpected child result') WHERE subagent_id = 'delegated'`;
        break;
      case "thread-index":
        yield* sql`UPDATE orchestration_v2_projection_threads SET title = 'Unexpected indexed title' WHERE thread_id = 'archived'`;
        break;
      case "orphan-message":
        yield* sql`UPDATE orchestration_v2_projection_messages SET thread_id = 'missing-thread' WHERE message_id = 'partial-message'`;
        break;
      case "partial-thread":
        yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.title', 'Unexpected replacement title') WHERE thread_id = 'archived'`;
        break;
      case "completed-project":
      case "no-op-project":
        yield* sql`UPDATE projection_projects SET title = 'Unexpected replacement project' WHERE project_id = ${projectId}`;
        break;
      case "added-thread":
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) SELECT 'added',project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,json_set(payload_json, '$.id', 'added') FROM orchestration_v2_projection_threads WHERE thread_id = 'archived'`;
        break;
      case "deleted-thread":
        yield* sql`DELETE FROM orchestration_v2_projection_threads WHERE thread_id = 'archived'`;
        break;
      case "added-project":
        yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('added','Unexpected','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
        break;
      case "deleted-project":
        yield* sql`DELETE FROM projection_projects WHERE project_id = 'project:second'`;
        break;
    }
    const retry = yield* freeze(input).pipe(Effect.result);
    assert.equal(retry._tag, "Failure");
    if (retry._tag === "Failure") assert.equal(retry.failure._tag, "HistoryFreezeRefused");
    assert.equal(yield* store.latestApplicationSequence, head);
    assert.deepStrictEqual(yield* prefix(head), events);
    for (let pass = 0; pass < 2; pass++) {
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* replayProjects;
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM projection_projects ORDER BY project_id`,
        projectsBefore,
      );
    }
    const finished = yield* freeze(input);
    assert.isAtLeast(finished.applicationSequence, head);
    assert.equal((yield* freeze(input)).applicationSequence, finished.applicationSequence);
  }).pipe(Effect.provide(layerFixture)),
);

it.effect.each(["before-write", "after-write", "after-checkpoint"] as const)(
  "resumes after an interrupted batch without duplicating the committed suffix (%s)",
  (boundary) =>
    Effect.gen(function* () {
      yield* seed();
      const store = yield* EventStore.EventStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const input = {
        operationId: "interrupted",
        frozenAt,
        expectedApplicationSequence: yield* store.latestApplicationSequence,
      };
      let calls = 0;
      const interrupted = yield* freeze(input).pipe(
        Effect.provideService(EventSink.EventSinkV2, {
          ...sink,
          commitCommand: (command) => {
            if (++calls !== 3) return sink.commitCommand(command);
            const failure = new EventSink.EventSinkWriteError({
              commandId: command.commandId,
              eventCount: command.events.length,
            });
            if (boundary === "before-write") return Effect.fail(failure);
            return sink
              .commitCommand(command)
              .pipe(
                Effect.flatMap((result) =>
                  boundary === "after-write"
                    ? Effect.fail(failure)
                    : sql`CREATE TEMP TRIGGER fail_freeze_batch BEFORE INSERT ON history_handoff.batches BEGIN SELECT RAISE(ABORT, 'Synthetic interruption after checkpoint'); END`.pipe(
                        Effect.orDie,
                        Effect.as(result),
                      ),
                ),
              );
          },
        }),
        Effect.flip,
      );
      assert.equal(
        interrupted._tag,
        boundary === "after-checkpoint" ? "SqlError" : "EventSinkWriteError",
      );
      assert.deepEqual(
        yield* sql`SELECT name FROM sqlite_temp_schema WHERE name = 'fail_freeze_batch'`,
        [],
      );
      const partialHead = yield* store.latestApplicationSequence;
      assert.isAbove(partialHead, input.expectedApplicationSequence);
      const partialEvents = yield* prefix(partialHead);
      const finished = yield* freeze(input);
      assert.isAbove(finished.applicationSequence, partialHead);
      assert.deepStrictEqual(yield* prefix(partialHead), partialEvents);
      assert.equal((yield* freeze(input)).applicationSequence, finished.applicationSequence);
    }).pipe(Effect.provide(layerFixture)),
);

it.effect("fences the real restart continuation consumer even for completed background work", () =>
  Effect.gen(function* () {
    yield* seed();
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const store = yield* EventStore.EventStoreV2;
    const calls: string[] = [];
    const threads = Layer.mock(ThreadManagementService.ThreadManagementService, {
      getThreadRecords: (id, fields, filter) =>
        projections.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
      dispatch: () =>
        Effect.sync(() => {
          calls.push("dispatch");
        }).pipe(Effect.andThen(Effect.die("Denied dispatch"))),
      recoverDelegatedTask: () => Effect.void,
    });
    const continuation = continueRestartedRun({
      threadId: ThreadId.make("restart-completed"),
      sourceRunId: RunId.make("restart-completed:run:1"),
    }).pipe(
      Effect.provide(
        Layer.merge(threads, ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
      ),
    );
    yield* continuation.pipe(Effect.exit);
    assert.deepEqual(calls, ["dispatch"]);
    calls.length = 0;
    yield* freeze({
      operationId: "restart-fence",
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    });
    yield* continuation;
    assert.deepEqual(calls, []);
    const p = yield* projections.getThreadProjection(ThreadId.make("restart-completed"));
    assert.equal(p.runs[0]?.status, "completed");
    assert.isTrue(p.turnItems.some((item) => item.type === "run_interrupt_request"));
  }).pipe(Effect.provide(layerFixture)),
);

it.effect(
  "makes zero VCS calls with fresh defaults and records explicit auto-pull opt-in as outside the freeze",
  () =>
    Effect.gen(function* () {
      yield* seed();
      const store = yield* EventStore.EventStoreV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      const calls: string[] = [];
      const vcs = Layer.mock(GitVcsDriver.GitVcsDriver, {
        statusDetails: (cwd) =>
          Effect.sync(() => {
            calls.push(cwd);
          }).pipe(Effect.andThen(Effect.die("Denied VCS"))),
      });
      const before = yield* projects.listShells();
      assert.lengthOf(before, 2);
      assert.isTrue(before.every((project) => project.autoPull));
      yield* autoPullProjects(before, { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true }).pipe(
        Effect.provide(vcs),
        Effect.exit,
      );
      assert.deepEqual(calls, ["/synthetic"]);
      calls.length = 0;
      yield* freeze({
        operationId: "autopull",
        frozenAt,
        expectedApplicationSequence: yield* store.latestApplicationSequence,
      });
      const after = yield* projects.listShells();
      assert.isTrue(after.every((project) => project.autoPull === false));
      assert.isFalse(DEFAULT_SERVER_SETTINGS.defaultAutoPull);
      assert.deepEqual(DEFAULT_SERVER_SETTINGS.projectSettingsOverrides, {});
      yield* autoPullProjects(after, DEFAULT_SERVER_SETTINGS).pipe(Effect.provide(vcs));
      assert.deepEqual(calls, []);
      yield* autoPullProjects(after, { ...DEFAULT_SERVER_SETTINGS, defaultAutoPull: true }).pipe(
        Effect.provide(vcs),
        Effect.exit,
      );
      assert.deepEqual(calls, ["/synthetic"]);
    }).pipe(Effect.provide(layerFixture)),
);

it.effect("refuses tampered receipts, projection drift and unknown entity payloads", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const store = yield* EventStore.EventStoreV2;
    const input = {
      operationId: "tamper",
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    };
    yield* freeze(input);
    yield* sql`UPDATE orchestration_command_receipts SET command_type = 'unrelated' WHERE command_id = 'history-freeze:tamper:execution:archived'`;
    const receiptError = yield* freeze(input).pipe(Effect.flip);
    assert.equal(receiptError._tag, "HistoryFreezeRefused");
    if (receiptError._tag === "HistoryFreezeRefused")
      assert.equal(receiptError.reason, "batch-receipt-mismatch");
    yield* sql`UPDATE orchestration_command_receipts SET command_type = 'history.copy-freeze' WHERE command_id = 'history-freeze:tamper:execution:archived'`;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.title', 'Unexpected change') WHERE thread_id = 'parent'`;
    const stateError = yield* freeze(input).pipe(Effect.flip);
    assert.equal(stateError._tag, "HistoryFreezeRefused");
    if (stateError._tag === "HistoryFreezeRefused")
      assert.equal(stateError.reason, "projection-state-mismatch");
    yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.status', 'unknown_future_status') WHERE thread_id = 'parent'`;
    const schemaError = yield* freeze(input).pipe(Effect.flip);
    assert.equal(schemaError._tag, "HistoryFreezeRefused");
    if (schemaError._tag === "HistoryFreezeRefused")
      assert.equal(schemaError.reason, "invalid-projections");
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("keeps usage recovery disabled after archived and settled histories are reopened", () =>
  Effect.gen(function* () {
    yield* seed();
    const store = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    for (const id of ["limit-past", "limit-future"]) {
      const p = yield* projections.getThreadProjection(ThreadId.make(id));
      const run = p.runs[0];
      assert.isDefined(run);
      if (run === undefined) return;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`archive:${id}`),
            threadId: p.thread.id,
            occurredAt: now,
            type: "thread.metadata-updated",
            payload: {
              ...p.thread,
              archivedAt: now,
              settledOverride: "settled",
              limitRecovery: {
                runId: run.id,
                resetAt:
                  id === "limit-past" ? "2026-10-17T10:30:00.000Z" : "2026-10-18T10:00:00.000Z",
                autoResume: true,
                snooze: true,
              },
            },
          },
        ],
      });
    }
    yield* freeze({
      operationId: "unarchive",
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    });
    for (const id of ["limit-past", "limit-future"]) {
      const p = yield* projections.getThreadProjection(ThreadId.make(id));
      yield* sink.write({
        events: [
          {
            id: EventId.make(`unarchive:${id}`),
            threadId: p.thread.id,
            occurredAt: frozenAt,
            type: "thread.metadata-updated",
            payload: { ...p.thread, archivedAt: null, settledOverride: null },
          },
        ],
      });
    }
    assert.deepEqual(
      yield* projections.getLimitRecoveryCandidates({
        now: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
        autoResume: true,
        snooze: true,
      }),
      [],
    );
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("refuses receipt collisions and unexpected heads", () =>
  Effect.gen(function* () {
    yield* seed();
    const store = yield* EventStore.EventStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    const head = yield* store.latestApplicationSequence;
    const wrongHead = yield* freeze({
      operationId: "collision",
      frozenAt,
      expectedApplicationSequence: head - 1,
    }).pipe(Effect.flip);
    assert.equal(wrongHead._tag, "HistoryFreezeRefused");
    yield* sink.commitRejectedCommand({
      commandId: CommandId.make("history-freeze:collision:execution:archived"),
      threadId: ThreadId.make("archived"),
      commandType: "unrelated",
      rejectedAt: now,
      error: "unrelated",
    });
    const error = yield* freeze({
      operationId: "collision",
      frozenAt,
      expectedApplicationSequence: head,
    }).pipe(Effect.flip);
    assert.equal(error._tag, "HistoryFreezeRefused");
    if (error._tag === "HistoryFreezeRefused")
      assert.equal(error.reason, "command-receipt-collision");
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("refuses WAL staging before creating a cross-database journal", () =>
  Effect.gen(function* () {
    yield* seed();
    const sql = yield* SqlClient.SqlClient;
    const events = yield* EventStore.EventStoreV2;
    const head = yield* events.latestApplicationSequence;
    yield* sql`PRAGMA main.journal_mode = WAL`;
    const error = yield* freeze({
      operationId: "wal-refused",
      frozenAt,
      expectedApplicationSequence: head,
    }).pipe(Effect.flip);
    assert.equal(error._tag, "HistoryFreezeRefused");
    if (error._tag === "HistoryFreezeRefused")
      assert.equal(error.reason, "unsupported-journal-mode");
    assert.equal(yield* events.latestApplicationSequence, head);
    const databases = yield* sql<{ name: string }>`PRAGMA database_list`;
    assert.isFalse(databases.some((database) => database.name === "history_handoff"));
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("refuses an orphan delegated child with its actual missing parent ID", () =>
  Effect.gen(function* () {
    const fixture = yield* seed();
    const sink = yield* EventSink.EventSinkV2;
    const events = yield* EventStore.EventStoreV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("orphan-lineage"),
          threadId: fixture.child.id,
          occurredAt: now,
          type: "thread.metadata-updated",
          payload: {
            ...fixture.child,
            lineage: { ...fixture.child.lineage, parentThreadId: ThreadId.make("missing-parent") },
          },
        },
      ],
    });
    const error = yield* freeze({
      operationId: "orphan",
      frozenAt,
      expectedApplicationSequence: yield* events.latestApplicationSequence,
    }).pipe(Effect.flip);
    assert.equal(error._tag, "HistoryFreezeRefused");
    if (error._tag === "HistoryFreezeRefused") {
      assert.equal(error.reason, "missing-delegated-parent");
      assert.equal(error.entityId, fixture.child.id);
    }
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("rejects ambiguous result linkage without inventing results", () =>
  Effect.gen(function* () {
    const fixture = yield* seed();
    const store = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* freeze({
      operationId: "variants",
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    });
    const parent = yield* projections.getThreadProjection(fixture.parent.id);
    const child = yield* projections.getThreadProjection(fixture.child.id);
    const task = parent.subagents.find((task) => task.id === "delegated");
    assert.isDefined(task);
    if (task === undefined) return;
    const transfer = parent.contextTransfers.find((entry) => entry.type === "subagent_result");
    assert.isDefined(transfer);
    if (transfer === undefined) return;
    const run = child.runs[0];
    assert.isDefined(run);
    if (run === undefined) return;
    const variants = [
      {
        parent: { ...parent, contextTransfers: [] },
        child,
        reason: "delegated-result-without-transfer",
      },
      {
        parent: { ...parent, subagents: [{ ...task, result: null }] },
        child,
        reason: "delegated-transfer-without-result",
      },
      {
        parent: { ...parent, subagents: [task, { ...task, id: NodeId.make("generation:2") }] },
        child,
        reason: "ambiguous-delegated-generations",
      },
      {
        parent: { ...parent, thread: { ...parent.thread, id: ThreadId.make("wrong-parent") } },
        child,
        reason: "inconsistent-delegated-lineage",
      },
      {
        parent: {
          ...parent,
          contextTransfers: [
            {
              ...transfer,
              sourcePoint: { threadId: child.thread.id, runId: RunId.make("wrong-run") },
            },
          ],
        },
        child,
        reason: "inconsistent-delegated-transfer",
      },
      {
        parent,
        child: { ...child, runs: [run, { ...run, id: RunId.make("second-run"), ordinal: 2 }] },
        reason: "ambiguous-delegated-runs",
      },
    ];
    for (const variant of variants)
      assert.throws(
        () => planDelegatedResult({ operationId: "variants", frozenAt, ...variant }),
        new RegExp(variant.reason),
      );
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("awaits legacy hydration and retains its text through freeze and repeated rebuild", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    const store = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const id = ThreadId.make("legacy");
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('legacy-project','Legacy','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at,archived_at) VALUES (${id},'legacy-project','Legacy discussion','{"instanceId":"codex","model":"synthetic"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('legacy-message',${id},'assistant','Original legacy partial answer','[]',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    assert.equal(yield* importer.pendingThreadCount, 1);
    yield* hydrateLegacyHistory();
    assert.equal(yield* importer.pendingThreadCount, 0);
    assert.equal(
      (yield* projections.getThreadProjection(id)).messages[0]?.text,
      "Original legacy partial answer",
    );
    yield* freeze({
      operationId: "legacy",
      frozenAt,
      expectedApplicationSequence: yield* store.latestApplicationSequence,
    });
    const frozen = yield* projections.getThreadProjection(id);
    for (let pass = 0; pass < 2; pass++) {
      assert.isTrue((yield* maintenance.rebuild).valid);
      yield* hydrateLegacyHistory();
      assert.equal(
        encodeProjection(yield* projections.getThreadProjection(id)),
        encodeProjection(frozen),
      );
    }
  }).pipe(Effect.provide(layerFixture)),
);

it.effect("propagates a legacy transcript decoding failure instead of claiming hydration", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* Legacy.LegacyV1ThreadImporter;
    yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('legacy-error-project','Legacy','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* sql`INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES ('legacy-error','legacy-error-project','Legacy discussion','{"instanceId":"codex","model":"synthetic"}','full-access','default','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* importer.reconcileShells;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('legacy-error-message','legacy-error','assistant','Do not lose this text','invalid-json',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    const rejected = yield* hydrateLegacyHistory().pipe(Effect.result);
    assert.equal(rejected._tag, "Failure", "malformed attachment must be refused");
    if (rejected._tag !== "Failure") return;
    const error = rejected.failure;
    assert.equal(error._tag, "HistoryFreezeRefused");
    if (error._tag === "HistoryFreezeRefused") assert.equal(error.reason, "invalid-legacy-message");
    assert.equal(yield* importer.pendingThreadCount, 1);
    assert.isNull(
      (yield* sql<{
        transcript_imported_at: string | null;
      }>`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = 'legacy-error'`)[0]
        ?.transcript_imported_at,
    );
    yield* sql`UPDATE projection_thread_messages SET attachments_json = '[]' WHERE message_id = 'legacy-error-message'`;
    yield* sql`INSERT INTO projection_thread_messages (message_id,thread_id,role,text,attachments_json,is_streaming,created_at,updated_at) VALUES ('legacy-older-message','legacy-error','assistant','Older retained answer','[]',0,'2025-12-01T00:00:00.000Z','2025-12-01T00:00:00.000Z')`;
    const sink = yield* EventSink.EventSinkV2;
    const failingImporter = Legacy.layer.pipe(
      Layer.provide(
        Layer.succeed(EventSink.EventSinkV2, {
          ...sink,
          write: (input) =>
            Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length })),
        }),
      ),
    );
    const rejectedWrite = yield* hydrateLegacyHistory().pipe(
      Effect.provide(Layer.fresh(failingImporter)),
      Effect.result,
    );
    assert.equal(rejectedWrite._tag, "Failure", "failed transcript commit must propagate");
    if (rejectedWrite._tag !== "Failure") return;
    const writeError = rejectedWrite.failure;
    assert.equal(writeError._tag, "LegacyV1ThreadImportError");
    assert.equal(yield* importer.pendingThreadCount, 1);
  }).pipe(Effect.provide(layerFixture)),
);
