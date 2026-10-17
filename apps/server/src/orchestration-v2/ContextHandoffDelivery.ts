import type {
  OrchestrationV2Command,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ProviderThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  latestNativeContextUsage,
  historyCost,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { continuationIdentitiesEqual } from "./ProviderSessionTransitionPolicy.ts";

type ConversationInput = Pick<
  Extract<OrchestrationV2Command, { type: "message.dispatch" }>,
  | "createdBy"
  | "creationSource"
  | "scheduledTaskId"
  | "senderThreadId"
  | "notification"
  | "delegatedCompletion"
  | "restartContinuationOfRunId"
  | "usageLimitContinuationOfRunId"
  | "usageLimitRecoveryRequestId"
  | "text"
  | "attachments"
>;

export function isExplicitConversationInput(input: ConversationInput): boolean {
  return (
    input.createdBy === "user" &&
    (input.creationSource === "web" || input.creationSource === "mobile") &&
    input.scheduledTaskId === undefined &&
    input.senderThreadId === undefined &&
    input.notification === undefined &&
    input.delegatedCompletion === undefined &&
    input.restartContinuationOfRunId === undefined &&
    input.usageLimitContinuationOfRunId === undefined &&
    input.usageLimitRecoveryRequestId === undefined &&
    !isNativeMaintenanceCommand(input) &&
    !(input.attachments.length === 0 && /^\/goal(?:\s|$)/u.test(input.text.trim()))
  );
}

type ContextProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "runs" | "messages" | "attempts" | "providerTurns" | "providerThreads"
>;

export const readNativeContext = Effect.fnUntraced(function* (input: {
  readonly projection: ContextProjection;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly run: Pick<OrchestrationV2Run, "id" | "ordinal" | "providerThreadId">;
  readonly initiation: ConversationInput;
}) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const { projection, providerThread, run } = input;
  const { contextHandoffs, messages } = yield* store.getThreadRecords(
    projection.thread.id,
    ["contextHandoffs", "messages"],
    { messageRoles: ["user"] },
  );
  const sourceMessage = (source: OrchestrationV2Run) =>
    messages.find((message) => message.id === source.userMessageId);
  const explicitRun = (source: OrchestrationV2Run) => {
    const message = sourceMessage(source);
    return (
      source.delegatedCompletion === undefined &&
      message !== undefined &&
      isExplicitConversationInput({
        ...message,
        restartContinuationOfRunId: source.restartContinuationOfRunId,
      })
    );
  };
  const canonicalInitial = (handoff: OrchestrationV2ContextHandoff) =>
    handoff.threadId === projection.thread.id &&
    handoff.strategy === "full_thread_summary" &&
    handoff.transferId === null &&
    projection.runs.some(
      (source) =>
        source.id === handoff.targetRunId &&
        source.contextHandoffId === handoff.id &&
        explicitRun(source),
    );
  const rootRows = projection.providerThreads.filter(
    (row) => row.appThreadId === projection.thread.id && row.ownerNodeId === null,
  );
  const rootIds = new Set(rootRows.map((row) => row.id));
  rootIds.add(providerThread.id);
  const nativeId = providerThread.nativeThreadRef?.nativeId ?? undefined;
  const identities = new Map<
    ProviderInstanceId,
    Effect.Success<ReturnType<typeof ProviderAdapterRegistry.getContinuationMetadata>>
  >();
  const identity = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    const cached = identities.get(instanceId);
    if (cached !== undefined) return cached;
    const metadata = yield* ProviderAdapterRegistry.getContinuationMetadata(instanceId);
    identities.set(instanceId, metadata);
    return metadata;
  });
  const compatible = Effect.fnUntraced(function* (instanceId: ProviderInstanceId) {
    if (instanceId === providerThread.providerInstanceId) return true;
    const current = yield* identity(instanceId);
    const target = yield* identity(providerThread.providerInstanceId);
    return continuationIdentitiesEqual(
      { driverKind: current.driver, continuationKey: current.continuationKey },
      { driverKind: target.driver, continuationKey: target.continuationKey },
    );
  });
  const aliases: OrchestrationV2ProviderThread[] = [];
  const settledHandoffs: OrchestrationV2ContextHandoff[] = [];
  const pendingHandoffs: OrchestrationV2ContextHandoff[] = [];
  const acceptedAttempts: OrchestrationV2ThreadProjection["attempts"][number][] = [];
  const acceptedIds = new Set(
    projection.providerTurns
      .filter((turn) => {
        const attempt = projection.attempts.find((candidate) => candidate.id === turn.runAttemptId);
        return attempt !== undefined && turn.nodeId === attempt.rootNodeId;
      })
      .map((turn) => turn.runAttemptId),
  );
  if (nativeId !== undefined) {
    for (const row of rootRows) {
      if (
        row.nativeThreadRef?.nativeId === nativeId &&
        row.nativeThreadRef.driver === providerThread.nativeThreadRef?.driver &&
        (yield* compatible(row.providerInstanceId))
      )
        aliases.push(row);
    }
    for (const attempt of projection.attempts) {
      if (
        rootIds.has(attempt.providerThreadId) &&
        attempt.nativeThreadId === nativeId &&
        acceptedIds.has(attempt.id) &&
        (yield* compatible(attempt.providerInstanceId))
      )
        acceptedAttempts.push(attempt);
    }
    const receipts = contextHandoffs.filter(
      (handoff) =>
        handoff.delivery?.nativeThreadId === nativeId &&
        (rootIds.has(handoff.toProviderThreadId) ||
          (canonicalInitial(handoff) &&
            projection.runs.some(
              (carrier) =>
                carrier.contextHandoffId === handoff.id &&
                rootRows.some((row) => row.id === carrier.providerThreadId),
            ))),
    );
    const events =
      receipts.length === 0
        ? []
        : yield* store.getContextHandoffDeliveryEvents(
            projection.thread.id,
            receipts.map((handoff) => handoff.id),
          );
    for (const handoff of receipts) {
      const event = events.find((event) => event.payload.id === handoff.id);
      const deliveringRun = projection.runs.find((source) => source.id === event?.runId);
      const instanceId = event?.providerInstanceId ?? deliveringRun?.providerInstanceId;
      if (instanceId === undefined || event?.payload.delivery?.nativeThreadId !== nativeId)
        return yield* new ContextHandoffProvenanceError();
      if (!(yield* compatible(instanceId))) continue;
      (handoff.delivery?.status === "pending" ? pendingHandoffs : settledHandoffs).push(handoff);
    }
  }
  const aliasIds = new Set(aliases.map((row) => row.id));
  aliasIds.add(providerThread.id);
  const eligibleHandoffs: OrchestrationV2ContextHandoff[] = [];
  for (const handoff of contextHandoffs) {
    if (handoff.status !== "ready") continue;
    if (
      handoff.delivery?.status === "pending" &&
      !pendingHandoffs.some((pending) => pending.id === handoff.id) &&
      rootRows.some(
        (row) =>
          row.id !== providerThread.id &&
          row.nativeThreadRef?.nativeId === handoff.delivery?.nativeThreadId,
      )
    )
      continue;
    if (handoff.targetRunId === run.id) {
      eligibleHandoffs.push(handoff);
      continue;
    }
    const source = projection.runs.find((candidate) => candidate.id === handoff.targetRunId);
    if (source === undefined) continue;
    const sameRow = handoff.toProviderThreadId === providerThread.id;
    if (sameRow && (source.status === "failed" || source.status === "interrupted")) {
      eligibleHandoffs.push(handoff);
      continue;
    }
    const message = sourceMessage(source);
    if (
      sameRow &&
      source.status === "completed" &&
      handoff.delivery === undefined &&
      message?.attachments.length === 0 &&
      message.text.trim().toLowerCase() === "/compact"
    ) {
      eligibleHandoffs.push(handoff);
      continue;
    }
    if (!canonicalInitial(handoff) || !isExplicitConversationInput(input.initiation)) continue;
    if (
      projection.runs.some(
        (carrier) =>
          carrier.id === run.id &&
          carrier.contextHandoffId === handoff.id &&
          carrier.providerThreadId === providerThread.id,
      )
    ) {
      eligibleHandoffs.push(handoff);
      continue;
    }
    const carriers = projection.runs.filter(
      (carrier) =>
        carrier.ordinal < run.ordinal &&
        carrier.contextHandoffId === handoff.id &&
        explicitRun(carrier) &&
        (carrier.status === "cancelled" ||
          carrier.status === "failed" ||
          carrier.status === "interrupted"),
    );
    for (const carrier of carriers) {
      if (carrier.providerThreadId === null || !aliasIds.has(carrier.providerThreadId)) continue;
      if (nativeId === undefined && carrier.providerThreadId !== providerThread.id) continue;
      if (nativeId !== undefined && !(yield* compatible(carrier.providerInstanceId))) continue;
      eligibleHandoffs.push(handoff);
      break;
    }
  }
  const missedRuns: OrchestrationV2Run[] = [];
  for (const source of projection.runs) {
    if (
      source.ordinal < run.ordinal &&
      source.providerThreadId !== null &&
      aliasIds.has(source.providerThreadId) &&
      (source.status === "failed" || source.status === "interrupted") &&
      !acceptedIds.has(source.activeAttemptId) &&
      (nativeId === undefined || (yield* compatible(source.providerInstanceId)))
    )
      missedRuns.push(source);
  }
  const measuredContext = rootRows
    .flatMap((row) => {
      const usage = latestNativeContextUsage(
        { ...projection, attempts: acceptedAttempts },
        {
          ...row,
          nativeThreadRef: providerThread.nativeThreadRef,
        },
      );
      return usage === undefined ? [] : [usage];
    })
    .toSorted((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0];
  const proof =
    nativeId === undefined
      ? "no_native"
      : pendingHandoffs.length > 0
        ? "replace"
        : settledHandoffs.some(canonicalInitial) ||
            acceptedAttempts.some((attempt) => {
              const source = projection.runs.find((source) => source.id === attempt.runId);
              return source !== undefined && explicitRun(source);
            })
          ? "established"
          : "unestablished";
  const scopedReceipts = new Set(
    [...settledHandoffs, ...pendingHandoffs].map((handoff) => handoff.id),
  );
  const eligible = eligibleHandoffs.map((handoff) => {
    if (
      nativeId === undefined ||
      handoff.delivery?.nativeThreadId !== nativeId ||
      scopedReceipts.has(handoff.id)
    )
      return handoff;
    const { delivery: _foreignDelivery, ...undelivered } = handoff;
    return undelivered;
  });
  return {
    proof,
    eligibleHandoffs: eligible,
    settledHandoffs,
    acceptedAttempts,
    missedRuns,
    measuredContext,
    aliases,
    rootRows,
  };
});

export const readCanonicalHandoffHistory = Effect.fnUntraced(function* (
  threadId: OrchestrationV2Run["threadId"],
  run: Pick<OrchestrationV2Run, "id" | "ordinal">,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const visible = yield* store.getThreadProjection(threadId);
  const localRuns = new Map(visible.runs.map((source) => [source.id, source]));
  const items = visible.visibleTurnItems
    .filter(({ item }) => {
      if (item.threadId !== threadId || item.runId === null) return true;
      if (item.runId === run.id) return false;
      const source = localRuns.get(item.runId);
      return source === undefined || source.ordinal < run.ordinal;
    })
    .map(({ item }) => item);
  const runs = [...visible.runs];
  for (const ancestor of new Set(items.map((item) => item.threadId))) {
    if (ancestor !== threadId)
      runs.push(...(yield* store.getThreadRecords(ancestor, ["runs"])).runs);
  }
  return { items, runs };
});

class ContextHandoffProvenanceError extends Schema.TaggedError<ContextHandoffProvenanceError>()(
  "ContextHandoffProvenanceError",
  {},
) {
  override get message() {
    return "Native history delivery has no authoritative account provenance.";
  }
}

/**
 * Persist before/after injection: an ambiguous pending delivery requires a fresh native thread.
 * Run `unsent` when the provider refused the turn before reading the prompt, so that
 * refusal does not leave an ambiguous marker behind.
 */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity; paginate with afterPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover history with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",limit:20,maxCharsPerItem:4000}); paginate with afterPosition=nextPosition. Follow fork/handoff source references in activity. For long items use itemId and textOffset=nextTextOffset until null.`;
    }
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages = pending
      .flatMap((handoff) => handoff.history?.messages ?? [])
      .filter((message) => {
        if (seen.has(message.itemId)) return false;
        seen.add(message.itemId);
        return true;
      });
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    const selected = selectHistory({
      messages,
      coverage: fullCoverage,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline) return { context: "", delivered: Effect.void, unsent: Effect.void };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...handoff,
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void };
      }
    } else {
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, input.persist, { discard: true });
      return { context: "", delivered: Effect.void, unsent: Effect.void };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, input.persist, { discard: true }),
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
