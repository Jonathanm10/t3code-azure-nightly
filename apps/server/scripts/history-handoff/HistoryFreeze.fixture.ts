import { assert } from "@effect/vitest";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../../src/orchestration-v2/ProjectStore.ts";
import * as ApplicationEvents from "../../src/persistence/OrchestrationEventStore.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../../src/persistence/Migrations.ts";
import * as EventSink from "../../src/orchestration-v2/EventSink.ts";
import { freezeHistory, historyLayer } from "./HistoryFreeze.ts";

export const now = DateTime.makeUnsafe("2026-10-17T10:00:00.000Z");
export const frozenAt = DateTime.makeUnsafe("2026-10-17T11:00:00.000Z");
const driver = ProviderDriverKind.make("codex");
const instance = ProviderInstanceId.make("synthetic-codex");
const modelSelection = { instanceId: instance, model: "synthetic-model" };
export const projectId = ProjectId.make("project:synthetic");
const sessionId = ProviderSessionId.make("session:shared");
const capabilities: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: true,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "native" },
};
const nativeRef = (id: string) => ({ driver, nativeId: id, strength: "strong" as const });
const makeThread = (
  id: string,
  extra: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id: ThreadId.make(id),
  projectId,
  title: id,
  providerInstanceId: instance,
  modelSelection,
  createdBy: "user",
  creationSource: "web",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "retained-branch",
  worktreePath: "/synthetic/worktree",
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: now,
  deletedAt: null,
  ...extra,
});
const runFor = (threadId: ThreadId, ordinal: number, status: OrchestrationV2Run["status"]) =>
  ({
    id: RunId.make(`${threadId}:run:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instance,
    modelSelection,
    providerThreadId: ProviderThreadId.make(`${threadId}:native`),
    userMessageId: MessageId.make(`${threadId}:message:${ordinal}`),
    rootNodeId: NodeId.make(`${threadId}:node:${ordinal}`),
    activeAttemptId: null,
    status,
    queuePosition: status === "queued" ? ordinal : null,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: ["failed", "completed", "cancelled"].includes(status) ? now : null,
    checkpointId: null,
    contextHandoffId: null,
  }) satisfies OrchestrationV2Run;
const itemFor = (threadId: ThreadId, run: OrchestrationV2Run | null, id: string) => ({
  id: TurnItemId.make(id),
  threadId,
  runId: run?.id ?? null,
  nodeId: run?.rootNodeId ?? null,
  providerThreadId: run?.providerThreadId ?? null,
  providerTurnId: null,
  nativeItemRef: nativeRef(`${id}:native`),
  parentItemId: null,
  ordinal: 0,
  status: "running" as const,
  title: id,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
});
export const layerFixture = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* fs.makeTempDirectoryScoped({ prefix: "t3-history-freeze-" });
    const database = Layer.effectDiscard(runMigrations()).pipe(
      Layer.provideMerge(NodeSqliteClient.layer({ filename: `${path}/statev2.sqlite` })),
    );
    return historyLayer.pipe(Layer.provideMerge(database));
  }),
).pipe(Layer.provide(NodeFileSystem.layer));

export const freeze = Effect.fnUntraced(function* (
  input: Omit<Parameters<typeof freezeHistory>[0], "journalPath">,
) {
  const sql = yield* SqlClient.SqlClient;
  const databases = yield* sql<{ name: string; file: string }>`PRAGMA database_list`;
  const main = databases.find((db) => db.name === "main");
  assert.isDefined(main);
  if (main === undefined) return yield* Effect.die("Missing fixture DB");
  return yield* freezeHistory({ ...input, journalPath: `${main.file}.operation.sqlite` });
});
export const seed = Effect.fnUntraced(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const events: OrchestrationV2DomainEvent[] = [];
  const emit = (event: Omit<OrchestrationV2DomainEvent, "id">) => {
    events.push(decodeEvent({ ...event, id: EventId.make(`fixture:${events.length}`) }));
  };
  const parent = makeThread("parent", {
    pullRequests: [
      {
        host: "github.com",
        repository: "synthetic/repo",
        number: 1,
        url: "https://example.invalid/pr/1",
        source: "manual",
        snapshot: null,
        stack: null,
        linkedAt: "2026-10-17T10:00:00.000Z",
        watch: {
          startedAt: "2026-10-17T10:00:00.000Z",
          headSha: null,
          failedChecks: [],
          passed: false,
          passedChecks: [],
          remarksThrough: "2026-10-17T10:00:00.000Z",
          remarkIds: [],
          conflicting: false,
          wakes: 0,
        },
      },
    ],
  });
  const child = makeThread("child", {
    createdBy: "agent",
    creationSource: "mcp",
    lineage: {
      parentThreadId: parent.id,
      rootThreadId: parent.id,
      relationshipToParent: "subagent",
    },
    forkedFrom: { type: "node", nodeId: NodeId.make("delegated") },
  });
  const queued = makeThread("queue");
  const preparing = makeThread("preparing");
  const restart = makeThread("restart-completed");
  const forked = makeThread("forked", {
    lineage: { parentThreadId: parent.id, rootThreadId: parent.id, relationshipToParent: "fork" },
    forkedFrom: { type: "run", threadId: parent.id, runId: RunId.make("parent:run:1") },
  });
  const runless = makeThread("runless");
  const archived = makeThread("archived", { archivedAt: now });
  const settled = makeThread("settled", { settledOverride: "settled", settledAt: now });
  const deleted = makeThread("deleted", { deletedAt: now });
  const limitPast = makeThread("limit-past");
  const limitFuture = makeThread("limit-future", {
    limitRecovery: {
      runId: RunId.make("wrong"),
      resetAt: "2026-10-18T00:00:00.000Z",
      autoResume: true,
    },
  });
  const threads = [
    parent,
    child,
    queued,
    preparing,
    restart,
    forked,
    runless,
    archived,
    settled,
    deleted,
    limitPast,
    limitFuture,
  ];
  for (const thread of threads)
    emit({ threadId: thread.id, occurredAt: now, type: "thread.created", payload: thread });
  for (const [index, thread] of [parent, child, runless].entries()) {
    emit({
      threadId: thread.id,
      occurredAt: now,
      type: "provider-session.attached",
      payload: {
        id: sessionId,
        driver,
        providerInstanceId: instance,
        status: "running",
        cwd: "/synthetic",
        model: "synthetic-model",
        capabilities,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    });
    emit({
      threadId: thread.id,
      occurredAt: now,
      type: "provider-thread.updated",
      payload: {
        id: ProviderThreadId.make(`${thread.id}:native`),
        driver,
        providerInstanceId: instance,
        providerSessionId: sessionId,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: nativeRef(`${thread.id}:original`),
        nativeConversationHeadRef: nativeRef(`${thread.id}:head`),
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ kind: "command", taskId: `background:${index}` }],
        goal: {
          objective: "Retain this original goal",
          status: "active",
          tokenBudget: 9000,
          tokensUsed: 123,
        },
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  const parentRun = {
    ...runFor(parent.id, 1, "waiting"),
    delegatedCompletion: {
      disposition: "open" as const,
      nextGeneration: 3,
      delivery: {
        generation: 2,
        messageId: MessageId.make("delivery-message"),
        taskIds: [NodeId.make("delegated")],
      },
    },
  };
  const childRun = { ...runFor(child.id, 1, "running"), delegatedTaskId: NodeId.make("delegated") };
  const runs = [
    parentRun,
    childRun,
    { ...runFor(queued.id, 1, "queued"), queueHeld: true },
    runFor(queued.id, 2, "queued"),
    runFor(queued.id, 3, "queued"),
    runFor(preparing.id, 1, "preparing"),
    {
      ...runFor(restart.id, 1, "completed"),
      restartCancelledBackgroundWork: [
        { kind: "task" as const, label: "Original awaited background task" },
      ],
    },
    runFor(archived.id, 1, "running"),
    runFor(settled.id, 1, "waiting"),
    runFor(deleted.id, 1, "starting"),
    runFor(limitPast.id, 1, "failed"),
    runFor(limitFuture.id, 1, "failed"),
  ];
  for (const run of runs) {
    emit({ threadId: run.threadId, occurredAt: now, type: "run.created", payload: run });
    emit({
      threadId: run.threadId,
      occurredAt: now,
      type: "node.updated",
      payload: {
        id: run.rootNodeId,
        threadId: run.threadId,
        runId: run.id,
        parentNodeId: null,
        rootNodeId: run.rootNodeId,
        kind: "root_turn",
        status: run.status === "failed" ? "failed" : "waiting",
        countsForRun: true,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    const message = {
      id: run.userMessageId,
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      role: "user" as const,
      createdBy: "user" as const,
      creationSource: "web" as const,
      text: `Original question ${run.id}`,
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
    };
    emit({
      threadId: run.threadId,
      occurredAt: now,
      type: "message.updated",
      payload: { ...message, text: `Earlier revision ${run.id}` },
    });
    emit({ threadId: run.threadId, occurredAt: now, type: "message.updated", payload: message });
  }
  const buffered = runFor(queued.id, 3, "queued");
  emit({
    threadId: queued.id,
    occurredAt: now,
    type: "message.updated",
    payload: {
      id: buffered.userMessageId,
      threadId: queued.id,
      runId: buffered.id,
      nodeId: null,
      role: "user",
      createdBy: "agent",
      creationSource: "server",
      text: "Buffered child completion wake",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      notification: {
        source: { kind: "delegated_task", taskIds: [NodeId.make("delegated")] },
        outcome: "updated",
        summary: "Buffered result",
      },
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "checkpoint-scope.created",
    payload: {
      id: CheckpointScopeId.make("checkpoint-scope"),
      threadId: parent.id,
      runId: parentRun.id,
      nodeId: parentRun.rootNodeId,
      parentScopeId: null,
      providerThreadId: parentRun.providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/synthetic",
      createdAt: now,
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "checkpoint.captured",
    payload: {
      id: CheckpointId.make("checkpoint"),
      threadId: parent.id,
      scopeId: CheckpointScopeId.make("checkpoint-scope"),
      runId: parentRun.id,
      nodeId: parentRun.rootNodeId,
      parentCheckpointId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: null,
      ref: CheckpointRef.make("refs/t3/checkpoints/synthetic"),
      status: "ready",
      files: [{ path: "original.ts", kind: "modified", additions: 2, deletions: 1 }],
      capturedAt: now,
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "run-attempt.updated",
    payload: {
      id: RunAttemptId.make("attempt"),
      nativeThreadId: "original-native",
      runId: parentRun.id,
      attemptOrdinal: 1,
      rootNodeId: parentRun.rootNodeId,
      providerInstanceId: instance,
      providerThreadId: parentRun.providerThreadId,
      providerTurnId: ProviderTurnId.make("turn"),
      reason: "initial",
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "provider-turn.updated",
    payload: {
      id: ProviderTurnId.make("turn"),
      providerThreadId: parentRun.providerThreadId,
      nodeId: parentRun.rootNodeId,
      runAttemptId: RunAttemptId.make("attempt"),
      nativeTurnRef: nativeRef("original-turn"),
      ordinal: 1,
      status: "running",
      startedAt: now,
      completedAt: null,
    },
  });
  emit({
    threadId: runless.id,
    occurredAt: now,
    type: "node.updated",
    payload: {
      id: NodeId.make("runless-node"),
      threadId: runless.id,
      runId: null,
      parentNodeId: null,
      rootNodeId: NodeId.make("runless-node"),
      kind: "root_turn",
      status: "running",
      countsForRun: false,
      providerThreadId: ProviderThreadId.make(`${runless.id}:native`),
      providerTurnId: null,
      nativeItemRef: nativeRef("runless-original"),
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    },
  });
  const task = {
    id: NodeId.make("delegated"),
    threadId: parent.id,
    runId: parentRun.id,
    parentNodeId: parentRun.rootNodeId,
    origin: "app_owned" as const,
    createdBy: "agent" as const,
    driver,
    providerInstanceId: instance,
    providerThreadId: childRun.providerThreadId,
    childThreadId: child.id,
    nativeTaskRef: null,
    prompt: "Retain this delegated request",
    title: "Child",
    model: null,
    completionDelivery: { state: "claimed" as const, observedByRunId: null },
    status: "running" as const,
    result: null,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
  };
  emit({ threadId: parent.id, occurredAt: now, type: "subagent.updated", payload: task });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "subagent.updated",
    payload: {
      ...task,
      id: NodeId.make("delivered-task"),
      childThreadId: null,
      status: "completed",
      completedAt: now,
      result: "Already delivered settled result",
      completionDelivery: { state: "delivered", observedByRunId: parentRun.id },
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "subagent.updated",
    payload: {
      ...task,
      id: NodeId.make("native-task"),
      origin: "provider_native",
      childThreadId: runless.id,
      nativeTaskRef: nativeRef("original-native-task"),
      completionDelivery: undefined,
    },
  });
  emit({
    threadId: runless.id,
    occurredAt: now,
    type: "provider-session.updated",
    payload: {
      id: ProviderSessionId.make("orphan-session"),
      driver,
      providerInstanceId: instance,
      status: "running",
      cwd: "/synthetic",
      model: "synthetic",
      capabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "turn-item.updated",
    payload: {
      ...itemFor(parent.id, parentRun, "delegate-item"),
      type: "subagent",
      subagentId: task.id,
      origin: "app_owned",
      driver,
      providerInstanceId: instance,
      childThreadId: child.id,
      prompt: task.prompt,
      result: null,
    },
  });
  for (const [index, capability] of (
    [
      { type: "message" },
      { type: "live", providerSessionId: sessionId },
      { type: "not_resumable", reason: "old" },
    ] as const
  ).entries()) {
    emit({
      threadId: parent.id,
      occurredAt: now,
      type: "runtime-request.updated",
      payload: {
        id: RuntimeRequestId.make(`request:${index}`),
        nodeId: parentRun.rootNodeId,
        providerTurnId: ProviderTurnId.make("turn"),
        nativeRequestRef: nativeRef(`request:${index}`),
        kind: "user_input",
        status: "pending",
        responseCapability: capability,
        createdAt: now,
        resolvedAt: null,
      },
    });
    emit({
      threadId: parent.id,
      occurredAt: now,
      type: "turn-item.updated",
      payload: {
        ...itemFor(parent.id, parentRun, `question:${index}`),
        type: "user_input_request",
        requestId: RuntimeRequestId.make(`request:${index}`),
        questions: [{ id: "q", header: "Question", question: "Keep this question?", options: [] }],
      },
    });
  }
  const items: OrchestrationV2TurnItem[] = [
    {
      ...itemFor(parent.id, parentRun, "reasoning"),
      type: "reasoning",
      text: "Partial reasoning survives",
      streaming: true,
    },
    {
      ...itemFor(runless.id, null, "runless-command"),
      type: "command_execution",
      input: "synthetic command",
      output: "Keep partial output",
    },
    {
      ...itemFor(parent.id, parentRun, "secret"),
      type: "secret_request",
      label: "Secret",
      reason: "Request text only",
      secretStatus: "pending",
    },
    {
      ...itemFor(parent.id, parentRun, "settled-output"),
      type: "assistant_message",
      status: "completed",
      completedAt: now,
      text: "Existing settled result survives exactly",
      messageId: MessageId.make("settled-output-message"),
      streaming: false,
    },
  ];
  for (const item of items)
    emit({ threadId: item.threadId, occurredAt: now, type: "turn-item.updated", payload: item });
  emit({
    threadId: parent.id,
    occurredAt: now,
    type: "message.updated",
    payload: {
      id: MessageId.make("partial-message"),
      threadId: parent.id,
      runId: parentRun.id,
      nodeId: parentRun.rootNodeId,
      role: "assistant",
      createdBy: "agent",
      creationSource: "provider",
      text: "Keep partial assistant text",
      attachments: [],
      streaming: true,
      createdAt: now,
      updatedAt: now,
    },
  });
  for (const [index, delivery] of (
    [
      undefined,
      { nativeThreadId: "original", status: "pending", itemIds: [] },
      { nativeThreadId: "other", status: "injected", itemIds: [] },
      undefined,
    ] as const
  ).entries()) {
    emit({
      threadId: parent.id,
      occurredAt: now,
      type: "context-handoff.updated",
      payload: {
        id: ContextHandoffId.make(`handoff:${index}`),
        threadId: parent.id,
        targetRunId: parentRun.id,
        fromProviderThreadIds: [],
        toProviderThreadId: parentRun.providerThreadId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: index === 3 ? "pending" : "ready",
        summaryMessageId: null,
        summaryText: `Keep summary ${index}`,
        ...(delivery === undefined ? {} : { delivery }),
        createdByProviderInstanceId: instance,
        createdAt: now,
        updatedAt: now,
      },
    });
  }
  for (const [index, status] of (
    ["pending", "resolved_native", "resolved_portable", "consumed", "failed"] as const
  ).entries())
    emit({
      threadId: parent.id,
      occurredAt: now,
      type: "context-transfer.created",
      payload: {
        id: ContextTransferId.make(`transfer:${index}`),
        type: "fork",
        sourceThreadId: parent.id,
        targetThreadId: parent.id,
        sourcePoint: {
          threadId: parent.id,
          runId: parentRun.id,
          providerThreadRef: nativeRef("transfer-original"),
        },
        basePoint: null,
        sourceProviderInstanceId: instance,
        targetProviderInstanceId: instance,
        targetRunId: parentRun.id,
        status,
        resolution: null,
        createdBy: "user",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    });
  for (const thread of [limitPast, limitFuture]) {
    const run = runFor(thread.id, 1, "failed");
    emit({
      threadId: thread.id,
      occurredAt: now,
      type: "turn-item.updated",
      payload: {
        ...itemFor(thread.id, run, `${thread.id}:error`),
        type: "error",
        status: "failed",
        completedAt: now,
        failure: {
          class: "usage_limit",
          code: null,
          retryable: true,
          message: "Synthetic limit",
          resetAt: thread === limitPast ? "2026-10-17T10:30:00.000Z" : "2026-10-18T10:00:00.000Z",
        },
      },
    });
  }
  for (const fixtureProjectId of [projectId, ProjectId.make("project:second")]) {
    yield* sink.commitProjectCommand({
      commandId: CommandId.make(`fixture:project:${fixtureProjectId}`),
      projectId: fixtureProjectId,
      commandType: "project.create",
      acceptedAt: now,
      event: {
        eventId: EventId.make(`fixture:project:${fixtureProjectId}`),
        aggregateKind: "project",
        aggregateId: fixtureProjectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId: fixtureProjectId,
          title: "Synthetic project",
          workspaceRoot: "/synthetic",
          defaultModelSelection: modelSelection,
          scripts: [],
          createdAt: DateTime.formatIso(now),
          updatedAt: DateTime.formatIso(now),
        },
      },
    });
    yield* sink.commitProjectCommand({
      commandId: CommandId.make(`fixture:project-pull:${fixtureProjectId}`),
      projectId: fixtureProjectId,
      commandType: "project.update",
      acceptedAt: now,
      event: {
        eventId: EventId.make(`fixture:project-pull:${fixtureProjectId}`),
        aggregateKind: "project",
        aggregateId: fixtureProjectId,
        occurredAt: DateTime.formatIso(now),
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.meta-updated",
        payload: {
          projectId: fixtureProjectId,
          autoPull: true,
          updatedAt: DateTime.formatIso(now),
        },
      },
    });
  }
  yield* sink.write({ events });
  return { threads, parent, child, parentRun, childRun, task };
});
const decodeEvent = Schema.decodeUnknownSync(Schema.toType(OrchestrationV2DomainEvent));

export const replayProjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects`;
      yield* events
        .readApplicationEvents({
          afterSequence: 0,
          throughSequence: yield* events.latestApplicationSequence,
        })
        .pipe(
          Stream.runForEach((event) =>
            "aggregateKind" in event && event.aggregateKind === "project"
              ? projects.apply(event)
              : Effect.void,
          ),
        );
    }),
  );
}).pipe(Effect.provide(ApplicationEvents.layer));
