import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ChatAttachment,
  CommandId,
  ContextTransferId,
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationMessageContext,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import {
  latestExecutedRun,
  latestRootProviderFailure,
} from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import * as EventStore from "../../src/orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../src/orchestration-v2/ProjectionStore.ts";
import * as ProjectionMaintenance from "../../src/orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import {
  isRestartContinuationSource,
  runOutcome,
} from "../../src/orchestration-v2/RestartBackgroundNote.ts";
import {
  HistoryFreezeRefused,
  readThread,
  eachThread,
  encodeJson,
  digest,
  openHistoryFreezeJournal,
} from "./HistoryFreezeJournal.ts";
import * as Legacy from "../../src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

export const persistenceLayer = Layer.mergeAll(
  EventStore.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
);
export const freezeLayer = Layer.mergeAll(
  EventSink.layer.pipe(Layer.provideMerge(persistenceLayer)),
  ProjectionMaintenance.layer.pipe(Layer.provide(persistenceLayer)),
).pipe(Layer.provideMerge(persistenceLayer));
export const historyLayer = Legacy.layer.pipe(
  Layer.provideMerge(freezeLayer),
  Layer.provideMerge(NodeCrypto.layer),
);

type EventWithoutId = OrchestrationV2DomainEvent extends infer E
  ? E extends OrchestrationV2DomainEvent
    ? Omit<E, "id">
    : never
  : never;
const encodeEvents = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(OrchestrationV2DomainEvent)),
);
const isRefused = Schema.is(HistoryFreezeRefused);
const activeRun = (run: OrchestrationV2Run) =>
  ["preparing", "queued", "starting", "running", "waiting"].includes(run.status);
const openWork = (status: string) => ["idle", "pending", "running", "waiting"].includes(status);
const freezeReason = "Copied history was stopped locally; the original runtime was not contacted.";
const cleanPoint = ({
  providerThreadRef: _thread,
  providerTurnRef: _turn,
  ...point
}: OrchestrationV2ContextSourcePoint) => point;

function eventBuilder(operationId: string, phase: string, threadId: ThreadId, now: DateTime.Utc) {
  const events: OrchestrationV2DomainEvent[] = [];
  return {
    events,
    emit(value: EventWithoutId) {
      events.push({
        ...value,
        id: EventId.make(`history-freeze:${operationId}:${phase}:${threadId}:${events.length}`),
      });
    },
    base: { threadId, occurredAt: now },
  };
}

export function planThreadFreeze(input: {
  readonly operationId: string;
  readonly frozenAt: DateTime.Utc;
  readonly projection: OrchestrationV2ThreadProjection;
}) {
  const { projection: p, frozenAt: now } = input;
  const { events, emit, base } = eventBuilder(input.operationId, "execution", p.thread.id, now);
  for (const run of p.runs) {
    const cohortOpen =
      run.delegatedCompletion?.disposition === "open" ||
      (run.delegatedCompletion === undefined &&
        p.subagents.some((task) => task.origin === "app_owned" && task.runId === run.id));
    if (activeRun(run) || cohortOpen || run.delegatedCompletion?.delivery != null) {
      emit({
        ...base,
        type: "run.updated",
        payload: {
          ...run,
          ...(activeRun(run)
            ? { status: "cancelled", queuePosition: null, queueHeld: false, completedAt: now }
            : {}),
          ...(cohortOpen || run.delegatedCompletion?.delivery != null
            ? {
                delegatedCompletion: {
                  disposition: "disposed",
                  nextGeneration: run.delegatedCompletion?.nextGeneration ?? 1,
                  delivery: null,
                },
              }
            : {}),
        },
      });
    }
    if (
      run.rootNodeId !== null &&
      run.providerThreadId !== null &&
      !p.turnItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request") &&
      (activeRun(run) ||
        run.status === "interrupted" ||
        isRestartContinuationSource(run, p.providerTurns))
    ) {
      emit({
        ...base,
        type: "turn-item.updated",
        payload: {
          id: derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-request" }),
          threadId: p.thread.id,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          type: "run_interrupt_request",
          status: "completed",
          title: "Imported copy stopped",
          message: freezeReason,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });
    }
  }
  for (const attempt of p.attempts) {
    if (!openWork(attempt.status) && attempt.nativeThreadId === undefined) continue;
    const { nativeThreadId: _nativeThreadId, ...retained } = attempt;
    emit({
      ...base,
      type: "run-attempt.updated",
      payload: {
        ...retained,
        ...(openWork(attempt.status) ? { status: "cancelled", completedAt: now } : {}),
      },
    });
  }
  for (const node of p.nodes) {
    if (!openWork(node.status) && node.nativeItemRef === null) continue;
    emit({
      ...base,
      type: "node.updated",
      payload: {
        ...node,
        nativeItemRef: null,
        ...(openWork(node.status) ? { status: "cancelled", completedAt: now } : {}),
      },
    });
  }
  for (const turn of p.providerTurns) {
    if (!openWork(turn.status) && turn.nativeTurnRef === null) continue;
    emit({
      ...base,
      type: "provider-turn.updated",
      payload: {
        ...turn,
        nativeTurnRef: null,
        ...(openWork(turn.status) ? { status: "cancelled", completedAt: now } : {}),
      },
    });
  }
  for (const message of p.messages) {
    if (message.streaming)
      emit({
        ...base,
        type: "message.updated",
        payload: { ...message, streaming: false, updatedAt: now },
      });
  }
  for (const item of p.turnItems) {
    const streaming = "streaming" in item && item.streaming;
    const secret = item.type === "secret_request" && item.secretStatus === "pending";
    if (!openWork(item.status) && !streaming && !secret && item.nativeItemRef === null) continue;
    emit({
      ...base,
      type: "turn-item.updated",
      payload: {
        ...item,
        nativeItemRef: null,
        ...(openWork(item.status) || secret ? { status: "cancelled", completedAt: now } : {}),
        ...("streaming" in item ? { streaming: false } : {}),
        ...(item.type === "secret_request" && secret ? { secretStatus: "cancelled" } : {}),
        updatedAt: now,
      },
    });
  }
  for (const request of p.runtimeRequests) {
    if (
      request.status !== "pending" &&
      request.nativeRequestRef === null &&
      request.responseCapability.type === "not_resumable"
    )
      continue;
    emit({
      ...base,
      type: "runtime-request.updated",
      payload: {
        ...request,
        nativeRequestRef: null,
        ...(request.status === "pending" ? { status: "cancelled", resolvedAt: now } : {}),
        responseCapability: { type: "not_resumable", reason: freezeReason },
      },
    });
  }
  for (const task of p.subagents) {
    const dispose =
      task.origin === "app_owned" &&
      (task.completionDelivery === undefined ||
        ["pending", "claimed"].includes(task.completionDelivery.state));
    if (!openWork(task.status) && !dispose && task.nativeTaskRef === null) continue;
    emit({
      ...base,
      type: "subagent.updated",
      payload: {
        ...task,
        nativeTaskRef: null,
        ...(openWork(task.status) ? { status: "cancelled", completedAt: now } : {}),
        ...(dispose ? { completionDelivery: { state: "disposed", observedByRunId: null } } : {}),
        updatedAt: now,
      },
    });
  }
  for (const handoff of p.contextHandoffs) {
    if (!["pending", "ready"].includes(handoff.status) && handoff.delivery === undefined) continue;
    const { delivery: _delivery, ...retained } = handoff;
    emit({
      ...base,
      type: "context-handoff.updated",
      payload: {
        ...retained,
        ...(["pending", "ready"].includes(handoff.status) ? { status: "superseded" } : {}),
        updatedAt: now,
      },
    });
  }
  for (const transfer of p.contextTransfers) {
    if (transfer.targetThreadId !== p.thread.id) continue;
    const sourcePoint = cleanPoint(transfer.sourcePoint);
    const basePoint = transfer.basePoint === null ? null : cleanPoint(transfer.basePoint);
    const executable = ["pending", "resolved_native", "resolved_portable"].includes(
      transfer.status,
    );
    const native = transfer.resolution?.strategy === "native_fork";
    if (
      !executable &&
      !native &&
      encodeJson(sourcePoint) === encodeJson(transfer.sourcePoint) &&
      encodeJson(basePoint) === encodeJson(transfer.basePoint)
    )
      continue;
    emit({
      ...base,
      type: "context-transfer.updated",
      payload: {
        ...transfer,
        sourcePoint,
        basePoint,
        ...(executable ? { status: "superseded" } : {}),
        ...(native ? { resolution: null } : {}),
        updatedAt: now,
      },
    });
  }
  for (const session of p.providerSessions) {
    if (session.status !== "stopped")
      emit({
        ...base,
        type: "provider-session.updated",
        payload: { ...session, status: "stopped", updatedAt: now },
      });
    emit({
      ...base,
      type: "provider-session.detached",
      payload: { providerSessionId: session.id, detachedAt: now, reason: freezeReason },
    });
  }
  for (const thread of p.providerThreads) {
    if (
      thread.status === "closed" &&
      thread.providerSessionId === null &&
      thread.nativeThreadRef === null &&
      thread.nativeConversationHeadRef === null &&
      (thread.pendingBackgroundTasks?.length ?? 0) === 0
    )
      continue;
    emit({
      ...base,
      type: "provider-thread.updated",
      payload: {
        ...thread,
        status: "closed",
        providerSessionId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        pendingBackgroundTasks: [],
        updatedAt: now,
      },
    });
  }
  const latest = latestExecutedRun(p.runs);
  const failure = latestRootProviderFailure(latest, p.turnItems);
  const limitRecovery =
    latest !== null && failure?.class === "usage_limit" && failure.resetAt != null
      ? { runId: latest.id, resetAt: failure.resetAt, autoResume: false, snooze: false }
      : p.thread.limitRecovery;
  const pullRequests = p.thread.pullRequests?.map(({ watch: _watch, ...link }) => link);
  const { rollbackRequestId: _rollback, ...thread } = p.thread;
  emit({
    ...base,
    type: "thread.metadata-updated",
    payload: {
      ...thread,
      activeProviderThreadId: null,
      titleRegeneration: null,
      ...(limitRecovery === undefined ? {} : { limitRecovery }),
      ...(pullRequests === undefined ? {} : { pullRequests }),
    },
  });
  return events;
}

export function planDelegatedResult(input: {
  readonly operationId: string;
  readonly frozenAt: DateTime.Utc;
  readonly parent: OrchestrationV2ThreadProjection;
  readonly child: OrchestrationV2ThreadProjection;
}) {
  const { parent, child, frozenAt: now } = input;
  const refuse = (reason: string) => {
    throw new HistoryFreezeRefused({ reason, entityId: child.thread.id });
  };
  if (
    child.thread.lineage.relationshipToParent !== "subagent" ||
    child.thread.lineage.parentThreadId !== parent.thread.id ||
    child.thread.forkedFrom?.type !== "node"
  ) {
    return refuse("inconsistent-delegated-lineage");
  }
  const tasks = parent.subagents.filter(
    (task) => task.origin === "app_owned" && task.childThreadId === child.thread.id,
  );
  if (tasks.length !== 1) return refuse("ambiguous-delegated-generations");
  const task = tasks[0];
  if (
    task === undefined ||
    task.threadId !== parent.thread.id ||
    task.id !== child.thread.forkedFrom.nodeId
  )
    return refuse("inconsistent-delegated-task");
  const transfers = parent.contextTransfers.filter(
    (transfer) =>
      transfer.type === "subagent_result" && transfer.sourceThreadId === child.thread.id,
  );
  const existingTransfer =
    task.result !== null && transfers.length === 1 ? transfers[0] : undefined;
  const taskRuns = child.runs.filter((run) => run.delegatedTaskId === task.id);
  if (taskRuns.length > 1) return refuse("ambiguous-delegated-runs");
  const runs =
    existingTransfer === undefined
      ? taskRuns
      : child.runs.filter((run) => run.id === existingTransfer.sourcePoint.runId);
  if (runs.length !== 1)
    return refuse(
      existingTransfer === undefined
        ? "ambiguous-delegated-runs"
        : "inconsistent-delegated-transfer",
    );
  const run = runs[0];
  if (
    run === undefined ||
    activeRun(run) ||
    (existingTransfer !== undefined && child.runs.some(activeRun))
  )
    return refuse("nonterminal-delegated-run");
  if (existingTransfer !== undefined && openWork(task.status))
    return refuse("nonterminal-delegated-task");
  if (
    run.restartContinuationOfRunId !== undefined ||
    child.runs.some((candidate) => candidate.restartContinuationOfRunId === run.id)
  ) {
    return refuse("delegated-restart-chain");
  }
  if (
    transfers.some(
      (transfer) =>
        transfer.targetThreadId !== parent.thread.id ||
        transfer.sourcePoint.threadId !== child.thread.id ||
        transfer.sourcePoint.runId !== run.id,
    ) ||
    (existingTransfer !== undefined &&
      (existingTransfer.status !== "consumed" ||
        run.threadId !== child.thread.id ||
        (taskRuns[0] !== undefined && taskRuns[0].id !== run.id) ||
        (run.delegatedTaskId !== undefined && run.delegatedTaskId !== task.id)))
  ) {
    return refuse("inconsistent-delegated-transfer");
  }
  if (existingTransfer !== undefined) return [];
  if (transfers.length !== 0) return refuse("delegated-transfer-without-result");
  if (task.result !== null) return refuse("delegated-result-without-transfer");
  if (task.completionDelivery?.state !== "disposed")
    return refuse("delegated-delivery-not-disposed");
  const outcome = runOutcome(run);
  if (
    outcome !== "completed" &&
    outcome !== "failed" &&
    outcome !== "cancelled" &&
    outcome !== "interrupted" &&
    outcome !== "rolled_back"
  )
    return refuse("nonterminal-delegated-run");
  const status = outcome === "rolled_back" ? "cancelled" : outcome;
  const result = subagentResultForRun(child, { ...run, status: outcome });
  const { events, emit, base } = eventBuilder(
    input.operationId,
    `result:${child.thread.id}`,
    parent.thread.id,
    now,
  );
  emit({
    ...base,
    type: "subagent.updated",
    payload: { ...task, status, result: result.text, completedAt: now, updatedAt: now },
  });
  const node = parent.nodes.find((candidate) => candidate.id === task.id);
  if (node !== undefined)
    emit({ ...base, type: "node.updated", payload: { ...node, status, completedAt: now } });
  const item = parent.turnItems.find(
    (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
  );
  if (item?.type === "subagent")
    emit({
      ...base,
      type: "turn-item.updated",
      payload: { ...item, status, result: result.text, completedAt: now, updatedAt: now },
    });
  emit({
    ...base,
    type: "context-transfer.created",
    payload: {
      id: ContextTransferId.make(`history-freeze:${input.operationId}:result:${task.id}`),
      type: "subagent_result",
      sourceThreadId: child.thread.id,
      targetThreadId: parent.thread.id,
      sourcePoint: {
        threadId: child.thread.id,
        runId: run.id,
        ...(result.turnItemId === null ? {} : { turnItemId: result.turnItemId }),
      },
      basePoint: null,
      sourceProviderInstanceId: run.providerInstanceId,
      targetProviderInstanceId: parent.thread.providerInstanceId,
      targetRunId: task.runId,
      status: "consumed",
      resolution: null,
      createdBy: "system",
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: now,
    },
  });
  emit({ ...base, type: "thread.metadata-updated", payload: parent.thread });
  return events;
}

const decodeLegacyMessage = Schema.decodeUnknownEffect(
  Schema.Struct({
    message_id: Schema.String,
    role: Schema.Literals(["user", "assistant"]),
    text: Schema.String,
    attachments_json: Schema.NullOr(Schema.fromJsonString(Schema.Array(ChatAttachment))),
    context_json: Schema.NullOr(Schema.fromJsonString(OrchestrationMessageContext)),
  }),
);

export const hydrateLegacyHistory = Effect.fn("history-handoff.hydrateLegacyHistory")(function* () {
  const importer = yield* Legacy.LegacyV1ThreadImporter;
  const sql = yield* SqlClient.SqlClient;
  yield* importer.reconcileShells;
  let after = "";
  while (true) {
    const rows = yield* sql<{
      thread_id: string;
    }>`SELECT thread_id FROM orchestration_v2_legacy_imports WHERE thread_id > ${after} ORDER BY thread_id LIMIT 32`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const initial = yield* sql<{
        transcript_imported_at: string | null;
      }>`SELECT transcript_imported_at FROM orchestration_v2_legacy_imports WHERE thread_id = ${row.thread_id}`;
      if (initial[0]?.transcript_imported_at === null) {
        let afterMessage = "";
        while (true) {
          const messages = yield* sql<{
            message_id: string;
          }>`SELECT message_id, role, text, attachments_json, context_json FROM projection_thread_messages WHERE thread_id = ${row.thread_id} AND message_id > ${afterMessage} ORDER BY message_id LIMIT 100`;
          if (messages.length === 0) break;
          for (const message of messages) {
            yield* decodeLegacyMessage(message).pipe(
              Effect.mapError(
                () =>
                  new HistoryFreezeRefused({
                    reason: "invalid-legacy-message",
                    entityId: message.message_id,
                  }),
              ),
            );
            afterMessage = message.message_id;
          }
        }
      }
      yield* importer.ensureTranscript(ThreadId.make(row.thread_id));
      if (initial[0]?.transcript_imported_at === null) {
        const missing = yield* sql<{
          message_id: string;
        }>`SELECT legacy.message_id FROM projection_thread_messages legacy LEFT JOIN orchestration_v2_projection_messages current ON current.message_id = legacy.message_id WHERE legacy.thread_id = ${row.thread_id} AND (current.message_id IS NULL OR json_extract(current.payload_json, '$.text') IS NOT legacy.text) LIMIT 1`;
        if (missing[0] !== undefined)
          return yield* new HistoryFreezeRefused({
            reason: "legacy-message-not-retained",
            entityId: missing[0].message_id,
          });
      }
      const pending = yield* sql<{
        transcript_imported_at: string | null;
        last_error: string | null;
      }>`SELECT transcript_imported_at, last_error FROM orchestration_v2_legacy_imports WHERE thread_id = ${row.thread_id}`;
      if (pending[0]?.transcript_imported_at == null || pending[0].last_error !== null)
        return yield* new HistoryFreezeRefused({
          reason: "legacy-transcript-incomplete",
          entityId: row.thread_id,
        });
      after = row.thread_id;
    }
  }
  if ((yield* importer.pendingThreadCount) !== 0)
    return yield* new HistoryFreezeRefused({ reason: "legacy-pending", entityId: "legacy" });
});

export const assertHistoryInert = Effect.fn("history-handoff.assertHistoryInert")(function* (
  now: DateTime.Utc,
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  for (const kind of [
    "queued-runs",
    "runtime",
    "subagent-results",
    "delegated-completions",
  ] as const) {
    const candidates = yield* projections.getRecoveryThreadIds(kind);
    if (candidates.length > 0)
      return yield* new HistoryFreezeRefused({
        reason: `recovery:${kind}`,
        entityId: candidates[0] ?? kind,
      });
  }
  yield* eachThread(
    Effect.fnUntraced(function* (id) {
      const p = yield* readThread(id);
      if (
        p.runs.some(activeRun) ||
        p.nodes.some((node) => openWork(node.status) || node.nativeItemRef !== null) ||
        p.attempts.some(
          (attempt) => openWork(attempt.status) || attempt.nativeThreadId !== undefined,
        ) ||
        p.providerTurns.some((turn) => openWork(turn.status) || turn.nativeTurnRef !== null) ||
        p.messages.some((message) => message.streaming) ||
        p.turnItems.some(
          (item) =>
            openWork(item.status) ||
            item.nativeItemRef !== null ||
            ("streaming" in item && item.streaming) ||
            (item.type === "secret_request" && item.secretStatus === "pending"),
        ) ||
        p.runtimeRequests.some(
          (request) =>
            request.status === "pending" ||
            request.nativeRequestRef !== null ||
            request.responseCapability.type !== "not_resumable",
        ) ||
        p.subagents.some(
          (task) =>
            openWork(task.status) ||
            task.nativeTaskRef !== null ||
            (task.origin === "app_owned" &&
              (task.completionDelivery === undefined ||
                ["pending", "claimed"].includes(task.completionDelivery.state))),
        )
      ) {
        return yield* new HistoryFreezeRefused({ reason: "open-or-native-record", entityId: id });
      }
    }),
  );
  if (
    (yield* projections.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }))
      .length > 0
  )
    return yield* new HistoryFreezeRefused({ reason: "usage-limit-recovery", entityId: "threads" });
  const roots = yield* sql<{ kind: string }>`
    SELECT 'binding' AS kind FROM orchestration_v2_projection_provider_session_bindings
    UNION ALL SELECT 'session' FROM orchestration_v2_projection_provider_sessions WHERE status <> 'stopped'
    UNION ALL SELECT 'provider-thread' FROM orchestration_v2_projection_provider_threads WHERE status <> 'closed' OR json_extract(payload_json, '$.providerSessionId') IS NOT NULL OR json_extract(payload_json, '$.nativeThreadRef') IS NOT NULL OR json_extract(payload_json, '$.nativeConversationHeadRef') IS NOT NULL OR json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
    UNION ALL SELECT 'active-provider' FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.activeProviderThreadId') IS NOT NULL
    UNION ALL SELECT 'watch' FROM orchestration_v2_projection_threads, json_each(payload_json, '$.pullRequests') pr WHERE json_extract(pr.value, '$.watch') IS NOT NULL
    UNION ALL SELECT 'auto-pull' FROM projection_projects WHERE auto_pull = 1
    UNION ALL SELECT 'transfer' FROM orchestration_v2_projection_context_transfers WHERE status IN ('pending','resolved_native','resolved_portable') OR json_extract(payload_json, '$.sourcePoint.providerThreadRef') IS NOT NULL OR json_extract(payload_json, '$.sourcePoint.providerTurnRef') IS NOT NULL OR json_extract(payload_json, '$.basePoint.providerThreadRef') IS NOT NULL OR json_extract(payload_json, '$.basePoint.providerTurnRef') IS NOT NULL OR json_extract(payload_json, '$.resolution.strategy') = 'native_fork'
    UNION ALL SELECT 'handoff' FROM orchestration_v2_projection_context_handoffs WHERE status IN ('pending','ready') OR json_extract(payload_json, '$.delivery') IS NOT NULL
    UNION ALL SELECT 'native-attempt' FROM orchestration_v2_projection_run_attempts WHERE json_extract(payload_json, '$.nativeThreadId') IS NOT NULL
    UNION ALL SELECT 'native-turn' FROM orchestration_v2_projection_provider_turns WHERE json_extract(payload_json, '$.nativeTurnRef') IS NOT NULL
    UNION ALL SELECT 'native-node' FROM orchestration_v2_projection_nodes WHERE json_extract(payload_json, '$.nativeItemRef') IS NOT NULL
    UNION ALL SELECT 'native-item' FROM orchestration_v2_projection_turn_items WHERE json_extract(payload_json, '$.nativeItemRef') IS NOT NULL
    UNION ALL SELECT 'native-task' FROM orchestration_v2_projection_subagents WHERE json_extract(payload_json, '$.nativeTaskRef') IS NOT NULL
    UNION ALL SELECT 'native-request' FROM orchestration_v2_projection_runtime_requests WHERE json_extract(payload_json, '$.nativeRequestRef') IS NOT NULL
    UNION ALL SELECT 'outbox' FROM orchestration_v2_effect_outbox
    LIMIT 1`;
  if (roots[0] !== undefined)
    return yield* new HistoryFreezeRefused({
      reason: `execution-root:${roots[0].kind}`,
      entityId: "destination",
    });
});

export const freezeHistory = Effect.fn("history-handoff.freezeHistory")(function* (input: {
  readonly operationId: string;
  readonly frozenAt: DateTime.Utc;
  readonly expectedApplicationSequence: number;
  readonly journalPath: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const store = yield* EventStore.EventStoreV2;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const refuse = (reason: string, entityId: string) =>
    new HistoryFreezeRefused({ reason, entityId });
  if (!(yield* maintenance.verify).valid)
    return yield* refuse("invalid-projections", "destination");
  const journal = yield* openHistoryFreezeJournal(input);

  const commit = Effect.fnUntraced(function* (
    batchId: string,
    threadId: ThreadId,
    plan: () => Effect.Effect<
      OrchestrationV2DomainEvent[],
      Effect.Error<ReturnType<typeof readThread>> | HistoryFreezeRefused,
      ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient
    >,
  ) {
    const expectedHead = yield* sql<{
      current_head: number;
    }>`SELECT current_head FROM history_handoff.operation`;
    if (expectedHead[0]?.current_head !== (yield* store.latestApplicationSequence))
      return yield* refuse("unexpected-head", batchId);
    const commandId = CommandId.make(`history-freeze:${input.operationId}:${batchId}`);
    const prior = yield* sql<{
      command_id: string;
      event_hash: string;
      result_head: number;
    }>`SELECT * FROM history_handoff.batches WHERE batch_id = ${batchId}`;
    const stored = yield* store.readByCommandId({ commandId }).pipe(Stream.runCollect);
    if (prior[0] !== undefined) {
      if (
        prior[0].command_id !== commandId ||
        (yield* digest(encodeEvents(stored.map((entry) => entry.event)))) !== prior[0].event_hash ||
        (stored.at(-1)?.sequence ?? 0) !== prior[0].result_head
      )
        return yield* refuse("batch-receipt-mismatch", batchId);
      const receipts = yield* sql<{
        aggregate_id: string;
        accepted_at: string;
        result_sequence: number;
        status: string;
        command_type: string;
      }>`SELECT aggregate_id, accepted_at, result_sequence, status, command_type FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
      const receipt = receipts[0];
      if (
        receipt?.aggregate_id !== threadId ||
        receipt.command_type !== "history.copy-freeze" ||
        receipt.status !== "accepted" ||
        receipt.result_sequence !== prior[0].result_head ||
        receipt.accepted_at !== DateTime.formatIso(input.frozenAt)
      )
        return yield* refuse("batch-receipt-mismatch", batchId);
      return;
    }
    if (stored.length > 0) return yield* refuse("unowned-command-events", batchId);
    const events = yield* plan();
    if (events.length === 0) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const { checkpoint } = yield* journal.verifyThreadBatch(events);
        const result = yield* sink.commitCommand({
          commandId,
          threadId,
          commandType: "history.copy-freeze",
          acceptedAt: input.frozenAt,
          events,
          effects: [],
        });
        if (!result.committed) return yield* refuse("command-receipt-collision", batchId);
        yield* checkpoint;
        const head = result.storedEvents.at(-1)?.sequence ?? 0;
        yield* sql`INSERT INTO history_handoff.batches VALUES (${batchId}, ${commandId}, ${yield* digest(encodeEvents(result.storedEvents.map((entry) => entry.event)))}, ${head})`;
        yield* sql`UPDATE history_handoff.operation SET current_head = ${head}`;
      }),
    );
  });

  let afterProject = "";
  while (true) {
    const rows = yield* sql<{
      project_id: string;
    }>`SELECT project_id FROM projection_projects WHERE project_id > ${afterProject} ORDER BY project_id LIMIT 32`;
    if (rows.length === 0) break;
    for (const row of rows) {
      const project = Option.getOrNull(
        yield* projects.get(ProjectId.make(row.project_id), { includeDeleted: true }),
      );
      const batchId = `project:${row.project_id}`;
      const commandId = CommandId.make(`history-freeze:${input.operationId}:${batchId}`);
      const prior = yield* sql<{
        event_hash: string;
        result_head: number;
      }>`SELECT * FROM history_handoff.batches WHERE batch_id = ${batchId}`;
      if (prior[0] !== undefined) {
        const events =
          yield* sql`SELECT * FROM orchestration_events WHERE command_id = ${commandId} ORDER BY sequence`;
        const receipts = yield* sql<{
          aggregate_id: string;
          result_sequence: number;
          status: string;
          command_type: string;
        }>`SELECT aggregate_id, result_sequence, status, command_type FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
        const receipt = receipts[0];
        if (
          project?.autoPull !== false ||
          prior[0].event_hash !== (yield* digest(encodeJson(events))) ||
          receipt?.aggregate_id !== row.project_id ||
          receipt.command_type !== "history.copy-freeze" ||
          receipt.status !== "accepted" ||
          receipt.result_sequence !== prior[0].result_head
        )
          return yield* refuse("project-receipt-mismatch", row.project_id);
      }
      if (project?.autoPull) {
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const { checkpoint } = yield* journal.verifyProject(project.projectId);
            const result = yield* sink.commitProjectCommand({
              commandId,
              projectId: project.projectId,
              commandType: "history.copy-freeze",
              acceptedAt: input.frozenAt,
              event: {
                eventId: EventId.make(`${commandId}:event`),
                aggregateKind: "project",
                aggregateId: project.projectId,
                type: "project.meta-updated",
                occurredAt: DateTime.formatIso(input.frozenAt),
                commandId,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                payload: {
                  projectId: project.projectId,
                  autoPull: false,
                  updatedAt: project.updatedAt,
                },
              },
            });
            if (!result.committed)
              return yield* refuse("project-receipt-collision", project.projectId);
            yield* checkpoint;
            const head = yield* store.latestApplicationSequence;
            const events =
              yield* sql`SELECT * FROM orchestration_events WHERE command_id = ${commandId} ORDER BY sequence`;
            yield* sql`INSERT INTO history_handoff.batches VALUES (${batchId}, ${commandId}, ${yield* digest(encodeJson(events))}, ${head})`;
            yield* sql`UPDATE history_handoff.operation SET current_head = ${head}`;
          }),
        );
      }
      afterProject = row.project_id;
    }
  }
  yield* eachThread((id) =>
    commit(
      `execution:${id}`,
      id,
      Effect.fnUntraced(function* () {
        return planThreadFreeze({ ...input, projection: yield* readThread(id) });
      }),
    ),
  );
  yield* eachThread(
    Effect.fnUntraced(function* (id) {
      const child = yield* readThread(id);
      if (
        child.thread.lineage.relationshipToParent !== "subagent" ||
        child.thread.creationSource === "provider"
      )
        return;
      const parentId = child.thread.lineage.parentThreadId;
      if (parentId === null) return yield* refuse("missing-delegated-parent", id);
      const parentExists =
        yield* sql`SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${parentId}`;
      if (parentExists.length === 0) return yield* refuse("missing-delegated-parent", id);
      yield* commit(
        `result:${id}`,
        parentId,
        Effect.fnUntraced(function* () {
          const parent = yield* readThread(parentId);
          return yield* Effect.try({
            try: () => planDelegatedResult({ ...input, parent, child }),
            catch: (error) => (isRefused(error) ? error : refuse("invalid-delegated-state", id)),
          });
        }),
      );
    }),
  );
  yield* assertHistoryInert(input.frozenAt);
  yield* journal.finish;
  return {
    applicationSequence: yield* store.latestApplicationSequence,
    agentSequence: yield* store.latestSequence(),
    alreadyFrozen: journal.alreadyFrozen,
  };
}, Effect.scoped);
