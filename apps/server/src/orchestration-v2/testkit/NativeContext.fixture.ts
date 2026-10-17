import * as EventSink from "../EventSink.ts";
import * as DateTime from "effect/DateTime";
import {
  EventId,
  ProviderInstanceId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Registry from "../ProviderAdapterRegistry.ts";
import * as F from "./DetachedHistoryContinuation.fixture.ts";

export const peerId = ProviderInstanceId.make("codex_synthetic_overlay");
export function providers(additional: ReadonlyArray<ReturnType<typeof F.makeProvider>> = []) {
  const provider = F.makeProvider();
  const peer = F.makeProvider(peerId);
  peer.controls.nativePrefix = F.selection.instanceId;
  const entries = [provider, peer, ...additional];
  const unavailable = new Set<ProviderInstanceId>();
  const keys = new Map(
    entries.map((entry) => [entry.adapter.instanceId, "codex:account:synthetic"]),
  );
  const registry = Layer.succeed(
    Registry.ProviderAdapterRegistryV2,
    Registry.ProviderAdapterRegistryV2.of({
      get: (id) => {
        const found = entries.find((entry) => entry.adapter.instanceId === id);
        return found === undefined || unavailable.has(id)
          ? Effect.fail(new Registry.ProviderAdapterRegistryLookupError({ instanceId: id }))
          : Effect.succeed(found.adapter);
      },
      list: () => Effect.succeed(entries.map((entry) => entry.adapter.instanceId)),
      getMetadata: (id) => {
        const found = entries.find((entry) => entry.adapter.instanceId === id);
        return found === undefined || unavailable.has(id)
          ? Effect.fail(new Registry.ProviderAdapterRegistryLookupError({ instanceId: id }))
          : Effect.succeed({
              driver: found.adapter.driver,
              continuationKey: keys.get(id)!,
              enabled: true,
              capabilities: found.controls.capabilities,
            });
      },
    }),
  );
  return { provider, peer, registry, unavailable, keys };
}

export const updateRow = Effect.fnUntraced(function* (
  row: OrchestrationV2ProviderThread,
  label: string,
) {
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(label),
        type: "provider-thread.updated",
        threadId: F.threadId,
        occurredAt: yield* DateTime.now,
        payload: row,
      },
    ],
  });
});
