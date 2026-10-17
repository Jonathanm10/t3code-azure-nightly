# Azure DevOps Server client

Portable, operation-scoped Azure DevOps Server access using the checkout's existing Git credential helper. No PAT setting or credential store is created. Requires Node 24+, Git and Effect 4.0.5.

```ts
import * as Effect from "effect/Effect";
import { makeNodeAzureServerClient } from "@jonathanm10/azure-devops-server-client";

const client = await Effect.runPromise(
  makeNodeAzureServerClient({
    id: "work",
    apiCollectionUrl: "https://git.example.test/tfs/Collection",
    credentialContext: "/absolute/path/to/checkout",
  }),
);
const result = await Effect.runPromise(client.execute("projects.list", { limit: 20 }));
```

`makeAzureServerClient` accepts a bounded Git process adapter and an Effect of configured profiles for native hosts. It obtains the Effect HTTP client from its construction context. `withSession` keeps a verified identity and opaque process-local credential fingerprint for a compound operation; the capability stops working when the callback ends. Standalone `execute` acquires a fresh verified session per operation. Read mode rejects writes before credential acquisition. WIQL remains a read despite its POST route.

Only the public root, `./addresses` and `./profile` exports are supported. The latter two are pure and safe in browser bundles. HTTP, Git envelopes and authenticated request functions stay private. The operation catalog derives input/output schemas and semantic access metadata from the same handlers.

Writes use typed operations. Work item updates require the revision returned by a read. Board moves resolve the board's actual field and state mappings and reread the item. PR completion requires an expected source commit, explicit strategy and explicit source-branch deletion choice, with policy bypass disabled. Comment API writes have a revision precheck but Azure's comments endpoint provides no atomic revision condition. A lost response yields `indeterminate`; read the resource before deciding whether to retry. Endpoint unavailability and permission denial are distinct outcomes. Comments use `6.0-preview.3`; state and backlog discovery use `6.0-preview.1`. Other routes use `6.0`, except the unversioned identity probe.

Every HTTP response is capped at 16 MiB, file reads at 4 MiB, Git output at 128 KiB, and helper/HTTP deadlines at 30 seconds. Returned data is schema-decoded and pages are bounded. Cursors are bound to the collection, checkout, credential context, route and filters, and expire when that context changes or the process restarts.

Synthetic tests prove protocol and write behavior. They do not establish that any particular customer deployment exposes or authorizes every endpoint. No customer resource is written by the test suite.
